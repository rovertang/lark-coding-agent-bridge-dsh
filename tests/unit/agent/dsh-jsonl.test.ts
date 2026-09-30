import { describe, expect, it } from 'vitest';
import { DshJsonlTranslator } from '../../../src/agent/dsh/jsonl.js';
import type { AgentEvent } from '../../../src/agent/types.js';

/** Feed the fixture lines through a fresh translator and collect the events. */
function run(lines: unknown[], withFinish = true): AgentEvent[] {
  const translator = new DshJsonlTranslator();
  const events: AgentEvent[] = [];
  for (const line of lines) events.push(...translator.translate(line));
  if (withFinish) events.push(...translator.finish());
  return events;
}

describe('DshJsonlTranslator', () => {
  it('translates a real captured run into the agent event vocabulary', () => {
    // Captured verbatim from `dsh --profile headless --json` (0.2.0-rc.2).
    expect(
      run([
        { type: 'session', sessionId: 'session-abc', cwd: 'C:\\ws' },
        { type: 'status', phase: 'turn_start', turn: 1 },
        { type: 'status', phase: 'step_start', turn: 1, step: 1 },
        { type: 'thinking', text: 'planning' },
        { type: 'text', text: 'po' },
        { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1896, outputTokens: 12, totalTokens: 1908, cacheReadTokens: 0 } },
        { type: 'status', phase: 'step_start', turn: 1, step: 2 },
        { type: 'text', text: 'pong' },
        { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 205, outputTokens: 2, totalTokens: 207 } },
        { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
        { type: 'final', text: 'pong' },
      ]),
    ).toEqual([
      { type: 'system', sessionId: 'session-abc', cwd: 'C:\\ws' },
      { type: 'thinking', delta: 'planning' },
      { type: 'text', delta: 'po' },
      { type: 'usage', inputTokens: 1896, outputTokens: 12, cachedInputTokens: 0, reasoningOutputTokens: undefined },
      { type: 'text', delta: 'ng' },
      { type: 'usage', inputTokens: 205, outputTokens: 2, cachedInputTokens: undefined, reasoningOutputTokens: undefined },
      { type: 'final_text', content: 'pong' },
      { type: 'done', sessionId: 'session-abc', terminationReason: 'normal' },
    ]);
  });

  it('prefix-diffs growing text snapshots instead of replaying them', () => {
    const translator = new DshJsonlTranslator();
    expect(translator.translate({ type: 'text', text: 'a' })).toEqual([{ type: 'text', delta: 'a' }]);
    expect(translator.translate({ type: 'text', text: 'ab' })).toEqual([{ type: 'text', delta: 'b' }]);
    // Identical snapshot: nothing new to say.
    expect(translator.translate({ type: 'text', text: 'ab' })).toEqual([]);
  });

  it('treats a non-prefix snapshot as a replacement rather than dropping it', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'text', text: 'first draft' });
    expect(translator.translate({ type: 'text', text: 'rewritten' })).toEqual([
      { type: 'text', delta: 'rewritten' },
    ]);
  });

  it('emits one usage event per step so the renderer can sum the run total', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: 10, outputTokens: 1 } });
    const second = translator.translate({
      type: 'status',
      phase: 'step_end',
      step: 2,
      usage: { input_tokens: 20, output_tokens: 2, reasoning_tokens: 7 },
    });
    expect(second).toEqual([
      { type: 'usage', inputTokens: 20, outputTokens: 2, cachedInputTokens: undefined, reasoningOutputTokens: 7 },
    ]);
  });

  it('maps tool calls and their results, flagging failures', () => {
    const translator = new DshJsonlTranslator();
    expect(
      translator.translate({ type: 'tool_call', callId: 'call_1', tool: 'pwsh', input: { command: 'ls' } }),
    ).toEqual([{ type: 'tool_use', id: 'call_1', name: 'pwsh', input: { command: 'ls' } }]);
    expect(
      translator.translate({ type: 'tool_result', callId: 'call_1', status: 'completed', result: 'ok' }),
    ).toEqual([{ type: 'tool_result', id: 'call_1', output: 'ok', isError: false }]);
    translator.translate({ type: 'tool_call', callId: 'call_2', tool: 'pwsh', input: {} });
    expect(
      translator.translate({ type: 'tool_result', callId: 'call_2', status: 'error', result: { message: 'boom' } }),
    ).toEqual([{ type: 'tool_result', id: 'call_2', output: '{"message":"boom"}', isError: true }]);
  });

  it('waits for `final` after turn_end instead of trusting the status', () => {
    const translator = new DshJsonlTranslator();
    expect(translator.translate({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })).toEqual([]);
    expect(translator.translate({ type: 'final', text: 'answer' })).toEqual([
      { type: 'final_text', content: 'answer' },
    ]);
    expect(translator.finish()).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });

  it('reports the MISSING_CREDENTIAL shape as a failed run', () => {
    // Captured: an error turn_end is followed by an empty final.
    expect(
      run([
        { type: 'session', sessionId: 'session-abc', cwd: 'C:\\ws' },
        { type: 'status', phase: 'turn_start', turn: 1 },
        {
          type: 'status',
          phase: 'turn_end',
          turn: 1,
          reason: {
            kind: 'error',
            error: { message: 'no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' },
          },
        },
        { type: 'final', text: '' },
      ]),
    ).toEqual([
      { type: 'system', sessionId: 'session-abc', cwd: 'C:\\ws' },
      {
        type: 'error',
        message: 'no API key for provider route "deepseek-official" (MISSING_CREDENTIAL)',
        terminationReason: 'failed',
      },
      // The empty final is not a turnaround: the error above stays terminal.
    ]);
  });

  it('reports an explicit stop as a stopped run, not a failure', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'status', phase: 'turn_start', turn: 1 });
    expect(translator.finish('interrupted')).toEqual([
      { type: 'done', sessionId: 'session-abc', terminationReason: 'interrupted' },
    ]);
  });

  it('promotes streamed text to the final answer when `final` never arrives', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'text', text: 'complete answer' });
    // The turn completed; only the trailing `final` event went missing.
    translator.translate({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
    expect(translator.finish()).toEqual([
      { type: 'final_text', content: 'complete answer' },
      { type: 'done', sessionId: 'session-abc', terminationReason: 'normal' },
    ]);
  });

  it('does not dress up partial text as an answer when the run never completed', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'text', text: 'half a sen' });
    expect(translator.finish()).toEqual([
      { type: 'error', message: 'dsh stream ended before a terminal event', terminationReason: 'failed' },
    ]);
  });

  it('fails a stream that ends before any terminal signal', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'status', phase: 'turn_start', turn: 1 });
    expect(translator.finish()).toEqual([
      { type: 'error', message: 'dsh stream ended before a terminal event', terminationReason: 'failed' },
    ]);
  });

  it('fails rather than silently succeeding on an unrecognized turn reason', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'status', phase: 'turn_end', reason: { kind: 'teleported' } });
    expect(translator.completedTurn()).toBe(false);
    expect(translator.finish()).toEqual([
      {
        type: 'error',
        message: 'dsh stream ended before a terminal event: unrecognized turn reason "teleported"',
        terminationReason: 'failed',
      },
    ]);
    expect(translator.protocolDrift().unknownEvents).toBe(1);
  });

  it('counts unknown events as protocol drift instead of failing the run', () => {
    const translator = new DshJsonlTranslator();
    expect(translator.translate({ type: 'quantum_flux', value: 1 })).toEqual([]);
    translator.translate({ type: 'status', phase: 'warp_speed' });
    expect(translator.translate({ type: 'final', text: 'still fine' })).toEqual([
      { type: 'final_text', content: 'still fine' },
    ]);
    expect(translator.finish()).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
    expect(translator.protocolDrift().unknownEvents).toBe(2);
  });

  it('ignores every event after a terminal one', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'session', sessionId: 'session-abc' });
    translator.translate({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
    translator.translate({ type: 'final', text: 'answer' });
    expect(translator.terminalEmitted()).toBe(false);
    translator.finish();
    expect(translator.terminalEmitted()).toBe(true);
    expect(translator.translate({ type: 'text', text: 'late' })).toEqual([]);
    expect(translator.finish()).toEqual([]);
  });

  it('reports no session id when DSH never announced one', () => {
    const translator = new DshJsonlTranslator();
    translator.translate({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
    expect(translator.finish()).toEqual([
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });
});
