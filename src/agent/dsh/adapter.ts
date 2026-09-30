import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildDshArgs, toDshPermissionMode } from './argv';
import { DshJsonlTranslator, type DshFinishReason } from './jsonl';
import {
  DSH_DEFAULT_PROFILE,
  ensureDshPatches,
  type DshProviderConfig,
} from './patches';

export { DSH_DEFAULT_PROFILE };

/**
 * `dsh --version` boots the packaged host through the Electron binary, which
 * takes a few seconds on a cold cache. The preflight default of 5s is too tight
 * for the Windows shim, so the DSH adapter asks for more.
 */
const DSH_VERSION_TIMEOUT_MS = 20_000;

export interface DshAdapterOptions {
  binary: string;
  /** Profile state dir; generated patch overlays are written under `dsh/`. */
  profileStateDir: string;
  provider: DshProviderConfig;
  /** DSH profile to boot. Defaults to {@link DSH_DEFAULT_PROFILE}. */
  profile?: string;
  /** Extra `--patch` overlays applied after the generated ones. */
  patches?: readonly string[];
  /** `DSH_HOME` override; inherits the ambient one when omitted. */
  dshHome?: string;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type DshChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/**
 * Drives DeepSeek Harness as an agent backend.
 *
 * One run is one `dsh --profile <profile> --json --patch … -` invocation: the
 * task arrives on stdin, newline-delimited run events come back on stdout, and
 * the process exits. Session continuity is DSH's own `session-<uuid>`, replayed
 * through `--session-id`, so the bridge treats DSH like Claude (a session id)
 * rather than like Codex (a thread id).
 *
 * Two environment facts carry the run's configuration because DSH reads them
 * from the environment rather than argv: `DSH_PERMISSION_MODE` (sandbox and
 * approval) and `DSH_HOME` (which state directory to use). Model and provider
 * selection travel as generated `--patch` overlays, so the DSH profile on disk
 * is never rewritten.
 */
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: string;
  private readonly profile: string;
  private readonly provider: DshProviderConfig;
  private readonly patchDir: string;
  private readonly extraPatches: readonly string[];
  private readonly dshHome: string | undefined;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly preparedByRun = new Map<string, string[]>();
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DshAdapterOptions) {
    this.binary = opts.binary;
    this.profile = opts.profile?.trim() || DSH_DEFAULT_PROFILE;
    this.provider = opts.provider;
    this.patchDir = join(opts.profileStateDir, 'dsh');
    this.extraPatches = opts.patches ?? [];
    this.dshHome = opts.dshHome;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'dsh',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
      args: ['--version'],
      timeoutMs: DSH_VERSION_TIMEOUT_MS,
    });
  }

  /**
   * Refresh the generated overlays for this run so `run()` can stay
   * synchronous, which the {@link AgentAdapter} contract requires. Keyed by
   * runId so two overlapping runs cannot see each other's patch set.
   */
  async prepareRun(opts: AgentRunOptions): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'dsh binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    const patchSet = await ensureDshPatches({
      dir: this.patchDir,
      provider: this.provider,
      ...(opts.model ? { model: opts.model } : {}),
      extraPatches: this.extraPatches,
    });
    this.preparedByRun.set(opts.runId, patchSet.patches);
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for DshAdapter.run');
    }

    // `prepareRun` already wrote these; falling back to the static overlays
    // keeps a direct run() call usable (it just loses the provider overlay).
    const patches = this.preparedByRun.get(opts.runId) ?? [...this.extraPatches];
    this.preparedByRun.delete(opts.runId);

    const permissionMode = toDshPermissionMode(opts.sandbox ?? this.sandbox);
    const args = buildDshArgs({
      profile: this.profile,
      patches,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });

    const envOverrides: NodeJS.ProcessEnv = {
      ...buildLarkChannelEnv(this.larkChannel),
      DSH_PERMISSION_MODE: permissionMode,
    };
    if (this.dshHome) envOverrides.DSH_HOME = this.dshHome;

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as DshChild;

    log.info('agent', 'spawn', {
      agent: 'dsh',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      permissionMode,
      patches: patches.length,
    });
    if (opts.images?.length) {
      // `dsh --profile headless` has no attachment flag; the bridge's image
      // paths are dropped rather than silently mis-parsed as task text.
      log.warn('agent', 'dsh-images-unsupported', { count: opts.images.length });
    }

    // Listeners MUST be attached synchronously here, before we return: 'error'
    // and the exit events can fire in the next tick, and a listener attached
    // later inside the generator body would miss them and hang the stream.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn dsh: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: DshFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'dsh', pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    const shim = isWindowsShim(this.binary);

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';

        if (shim) {
          // Windows cannot deliver SIGTERM, and the configured binary is a
          // .cmd shim (libuv runs it through cmd.exe). Killing the shim would
          // leave the real DSH host running as an orphan, so the whole tree is
          // terminated by pid while the shim still links it.
          log.info('agent', 'stop-taskkill', { pid: child.pid ?? null, reason: 'windows-shim' });
          killWindowsProcessTree(child.pid);
          await waitForChildExit(child, stopGraceMs);
          if (child.exitCode === null && child.signalCode === null) {
            // taskkill could not reach the tree (permissions, or the pid was
            // already reparented): fall back to killing what we do own so the
            // stop still settles.
            log.warn('agent', 'stop-sigkill', {
              pid: child.pid ?? null,
              graceMs: stopGraceMs,
              reason: 'taskkill-grace-expired',
            });
            child.kill('SIGKILL');
          }
          return;
        }

        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: DshChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => DshFinishReason | undefined,
): AsyncGenerator<AgentEvent> {
  const translator = new DshJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn dsh: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Non-JSON stdout is diagnostics leaking out of the host; stderr
        // already captured the same text with its own warning.
        continue;
      }
      yield* translator.translate(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`dsh runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  // A non-zero exit after a completed turn is a host-teardown hiccup, not a
  // lost answer: `final` already carried the reply, so it is not discarded.
  if (exitCode !== 0 && exitCode !== null && !translator.completedTurn()) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`dsh exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (exitCode !== 0 && exitCode !== null) {
    log.warn('agent', 'dsh-nonzero-after-completion', { exitCode });
  }

  const runtimeError = getError();
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`dsh runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: DshChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function waitForChildExit(child: DshChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

/**
 * True when the configured command is a Windows batch shim, i.e. the process we
 * actually own is cmd.exe rather than the agent itself.
 */
function isWindowsShim(binary: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
}

/**
 * Terminate a process and its descendants on Windows.
 *
 * `taskkill /T` is the only reliable way to reach a grandchild, and stdio is
 * 'ignore' so nothing is captured through a pipe (which is disallowed under the
 * Windows sandbox). It is invoked by absolute path because the bridge may run
 * with a PATH that omits `System32` — a service manager or a detached daemon
 * can easily be started with a minimal environment, and a bare `taskkill` then
 * fails with ENOENT exactly when a stop is most needed. Failure is non-fatal:
 * the caller's grace wait still bounds the stop.
 */
function killWindowsProcessTree(pid: number | undefined): void {
  if (!pid) return;
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
  try {
    const killer = spawnProcess(taskkill, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', (err) => {
      log.warn('agent', 'stop-taskkill-failed', { pid, message: err.message });
    });
  } catch (err) {
    log.warn('agent', 'stop-taskkill-failed', {
      pid,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
