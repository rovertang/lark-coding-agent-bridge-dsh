import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

export type DshFinishReason = 'failed' | 'interrupted' | 'timeout';

export interface DshProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates DSH's `--json` run-event stream into {@link AgentEvent}s.
 *
 * Observed vocabulary (dsh 0.2.0-rc.2, captured from real headless runs):
 *
 * ```json
 * {"type":"session","sessionId":"session-…","cwd":"…"}
 * {"type":"status","phase":"turn_start","turn":1}
 * {"type":"status","phase":"step_start","turn":1,"step":1}
 * {"type":"status","phase":"step_end","turn":1,"step":1,"usage":{…}}
 * {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
 * {"type":"thinking","text":"…"}
 * {"type":"text","text":"…"}
 * {"type":"tool_call","callId":"call_…","tool":"pwsh","input":{…}}
 * {"type":"tool_result","callId":"call_…","status":"completed|error","result":"…"}
 * {"type":"final","text":"…"}
 * ```
 *
 * Three ordering/shape facts drive the design:
 *
 *  1. `turn_end` — which carries the terminal reason — arrives **before**
 *     `final`. So this class does not emit `done` on `turn_end`; it records the
 *     reason and the adapter emits exactly one terminal event at stream end.
 *     Error reasons are terminal immediately, because `final` follows them with
 *     an empty text and there is nothing left to wait for.
 *  2. `text` is a **snapshot of a step's assistant message, not a delta**: the
 *     whole message is re-sent (longer) as it grows, and `final` repeats the
 *     last one in full. Deltas are therefore derived by prefix-diffing. The
 *     same code stays correct if a future build switches to true deltas, since
 *     a genuine delta is never a prefix-extension of what came before.
 *  3. A turn can span several steps, and each step reports its **own** usage
 *     (step 1: 1896 input tokens, step 2: 205 — not cumulative). Emitting one
 *     usage event per step therefore lets the renderer sum to the run total.
 *
 * Unknown `type`/`phase`/`reason.kind` values are counted as protocol drift and
 * ignored rather than failing the run — a bridge must survive a DSH release
 * that adds an event.
 */
export class DshJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private turnCompleted = false;
  /** Latest assistant text seen, i.e. everything already emitted as deltas. */
  private streamed = '';
  private finalText: string | undefined;
  private lastThinking = '';
  private lastNonTerminalError: string | undefined;
  private unknownTurnReason: string | undefined;
  private readonly openCalls = new Set<string>();
  private drift: DshProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'session':
        return this.translateSession(raw);
      case 'status':
        return this.translateStatus(raw);
      case 'thinking':
        return this.translateThinking(raw);
      case 'text':
        return this.translateText(raw);
      case 'tool_call':
        return this.translateToolCall(raw);
      case 'tool_result':
        return this.translateToolResult(raw);
      case 'final':
        return this.translateFinal(raw);
      case 'error':
        return this.translateNonTerminalError(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  /**
   * Produce the terminal event for a stream that ended without one. Called by
   * the adapter once stdout closes; `reason` describes why the adapter is
   * finishing (a stop request, an exit code, or nothing).
   */
  finish(reason: DshFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;

    // An explicit stop or timeout is authoritative: the adapter only passes
    // these when stop() ran or a deadline fired, so a user-requested halt is
    // reported as a stopped run even if the turn had already answered.
    if (reason !== 'failed') {
      return this.pendingFinalText([
        { type: 'done', sessionId: this.sessionId, terminationReason: reason },
      ]);
    }

    const completed = this.turnCompleted || this.finalText !== undefined;
    if (!completed) {
      const detail =
        this.lastNonTerminalError ??
        (this.unknownTurnReason ? `unrecognized turn reason "${this.unknownTurnReason}"` : undefined);
      const suffix = detail ? `: ${detail}` : '';
      // No promotion of streamed text here: the run did not finish, so partial
      // progress stays progress and the error is the delivery.
      return [
        {
          type: 'error',
          message: truncate(`dsh stream ended before a terminal event${suffix}`, 4096),
          terminationReason: 'failed',
        },
      ];
    }

    return this.pendingFinalText([
      { type: 'done', sessionId: this.sessionId, terminationReason: 'normal' },
    ]);
  }

  fail(message: string, terminationReason: 'failed' | 'interrupted' | 'timeout' = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message: truncate(message, 4096), terminationReason }];
  }

  protocolDrift(): DshProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  /**
   * True once DSH reported a completed turn. The adapter uses this to prefer a
   * real answer over a trailing non-zero exit code: DSH answers and then tears
   * its host down, and a shutdown hiccup must not discard a delivered reply.
   */
  completedTurn(): boolean {
    return this.turnCompleted || this.finalText !== undefined;
  }

  private translateSession(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.sessionId ?? raw.session_id);
    if (!sessionId) this.drift.anomalies++;
    this.sessionId = sessionId;
    return [
      {
        type: 'system',
        ...(sessionId ? { sessionId } : {}),
        ...(stringValue(raw.cwd) ? { cwd: stringValue(raw.cwd) as string } : {}),
      },
    ];
  }

  private translateStatus(raw: Record<string, unknown>): AgentEvent[] {
    const phase = stringValue(raw.phase);
    switch (phase) {
      case 'turn_start':
      case 'step_start':
        return [];
      case 'step_end':
        return this.translateStepEnd(raw);
      case 'turn_end':
        return this.translateTurnEnd(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_status_phase', { phase });
        return [];
    }
  }

  private translateStepEnd(raw: Record<string, unknown>): AgentEvent[] {
    const usage = recordValue(raw.usage);
    if (!usage) return [];
    const event: AgentEvent = {
      type: 'usage',
      inputTokens: numberValue(usage.inputTokens ?? usage.input_tokens),
      outputTokens: numberValue(usage.outputTokens ?? usage.output_tokens),
      cachedInputTokens: numberValue(usage.cacheReadTokens ?? usage.cachedInputTokens),
      reasoningOutputTokens: numberValue(
        usage.reasoningTokens ?? usage.reasoningOutputTokens ?? usage.reasoning_tokens,
      ),
    };
    return [event];
  }

  private translateTurnEnd(raw: Record<string, unknown>): AgentEvent[] {
    const reason = recordValue(raw.reason);
    const kind = stringValue(reason?.kind);
    switch (kind) {
      case 'completed':
        this.turnCompleted = true;
        return [];
      case 'interrupted':
      case 'aborted':
      case 'cancelled':
      case 'canceled':
        this.terminal = true;
        return [
          { type: 'done', sessionId: this.sessionId, terminationReason: 'interrupted' },
        ];
      case 'timeout':
        this.terminal = true;
        return [
          {
            type: 'error',
            message: truncate(errorDetail(reason, 'dsh turn timed out'), 4096),
            terminationReason: 'timeout',
          },
        ];
      case 'error':
      case 'failed':
        this.terminal = true;
        return [
          {
            type: 'error',
            message: truncate(errorDetail(reason, 'dsh turn failed'), 4096),
            terminationReason: 'failed',
          },
        ];
      default:
        // Neither a success nor an error we understand: remember it so a run
        // that ends here is reported as a failure instead of a silent success.
        this.drift.unknownEvents++;
        this.unknownTurnReason = kind ?? '(absent)';
        log.warn('jsonl', 'unknown_turn_reason', { kind: kind ?? null });
        return [];
    }
  }

  private translateThinking(raw: Record<string, unknown>): AgentEvent[] {
    const text = stringValue(raw.text);
    if (text === undefined) {
      this.drift.anomalies++;
      return [];
    }
    if (!text || text === this.lastThinking) return [];
    // DSH sends one thinking snapshot per step; prefix-diff so a growing
    // snapshot does not replay its whole body on every update.
    const delta = text.startsWith(this.lastThinking) ? text.slice(this.lastThinking.length) : text;
    this.lastThinking = text;
    return delta ? [{ type: 'thinking', delta }] : [];
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const text = stringValue(raw.text);
    if (text === undefined) {
      this.drift.anomalies++;
      return [];
    }
    if (text === this.streamed) return [];
    const delta = text.startsWith(this.streamed) ? text.slice(this.streamed.length) : text;
    this.streamed = text;
    return delta ? [{ type: 'text', delta }] : [];
  }

  private translateToolCall(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.callId ?? raw.call_id ?? raw.id);
    const name = stringValue(raw.tool ?? raw.name);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    this.openCalls.add(id);
    return [{ type: 'tool_use', id, name, input: raw.input ?? {} }];
  }

  private translateToolResult(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.callId ?? raw.call_id ?? raw.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.openCalls.delete(id)) this.drift.anomalies++;
    const status = stringValue(raw.status);
    if (status && !KNOWN_TOOL_STATUSES.has(status)) {
      this.drift.unknownEvents++;
      log.warn('jsonl', 'unknown_tool_status', { status });
    }
    return [
      {
        type: 'tool_result',
        id,
        output: renderToolResult(raw.result),
        // Only the two observed success spellings count as success: for a
        // remote-control bridge, mislabelling a failure as success is worse
        // than the reverse, so an unrecognized status surfaces as an error.
        isError: status === undefined ? false : !SUCCESS_TOOL_STATUSES.has(status),
      },
    ];
  }

  private translateFinal(raw: Record<string, unknown>): AgentEvent[] {
    const text = stringValue(raw.text);
    this.finalText = text ?? '';
    return text ? [{ type: 'final_text', content: text }] : [];
  }

  private translateNonTerminalError(raw: Record<string, unknown>): AgentEvent[] {
    const message = errorMessage(raw, 'dsh error');
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }

  /**
   * Emit the last streamed text as the final answer when DSH never sent a
   * `final` event. Mirrors the Codex translator, which promotes its pending
   * agent message at turn end for the same reason: without it a run that
   * streamed a complete answer would be delivered as progress commentary only.
   */
  private pendingFinalText(events: AgentEvent[]): AgentEvent[] {
    if (this.finalText !== undefined || !this.streamed) return events;
    this.finalText = this.streamed;
    return [{ type: 'final_text', content: this.streamed }, ...events];
  }
}

const SUCCESS_TOOL_STATUSES = new Set(['completed', 'ok', 'success', 'succeeded']);
const KNOWN_TOOL_STATUSES = new Set([...SUCCESS_TOOL_STATUSES, 'error', 'failed', 'failure']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `reason.error` is `{message, code}` on failure and absent on success. */
function errorDetail(reason: Record<string, unknown> | undefined, fallback: string): string {
  const error = recordValue(reason?.error);
  const message = stringValue(error?.message) ?? stringValue(reason?.message);
  if (!message) return fallback;
  const code = stringValue(error?.code);
  return code ? `${message} (${code})` : message;
}

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return (
    stringValue(raw.message) ??
    stringValue(nested?.message) ??
    stringValue(raw.error) ??
    fallback
  );
}

function renderToolResult(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
