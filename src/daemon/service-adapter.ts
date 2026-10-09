import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath, windowsTaskName } from './paths';
import * as schtasks from './schtasks';
import * as systemd from './systemd';
import { resolveAppPaths } from '../config/app-paths';
import { paths } from '../config/paths';
import { checkRuntimeLock, clearRuntimeLockArtifacts } from '../runtime/locks';
import { isAlive, liveEntriesForProfile, readAndPrune } from '../runtime/registry';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

/** Some platforms' restart is sync (spawnSync), others (schtasks) are
 * naturally async. Adapter methods can return either; callers await. */
export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

/**
 * Platform-agnostic interface over OS service managers (launchd / systemd /
 * schtasks). All methods are best-effort idempotent — calling stop()
 * on an already-stopped service returns ok=true.
 */
export interface ServiceAdapter {
  /** Display name used in error / status messages. */
  readonly platformName: string;

  /** Whether the service file (plist / unit / task) is on disk / registered. */
  fileExists(): boolean;

  /** Whether the service is currently running (process alive). */
  isRunning(): boolean;

  /** Path/name to the service definition (for status output). */
  servicePath(): string;

  /** Write or overwrite the service definition. */
  install(): Promise<void>;

  /** Start the service (enables autostart where applicable). */
  start(): ServiceResultLike;

  /** Stop the service. Does NOT disable autostart on its own. */
  stop(): ServiceResultLike;

  /** Stop + disable autostart. Used by `unregister` flow. */
  stopAndDisableAutostart(): ServiceResultLike;

  /**
   * Turn off autostart on an already-stopped service, without trying to stop
   * it again. `stop` needs this: a service that is registered but not running
   * would otherwise keep its login-time autostart and come back by itself.
   */
  disableAutostart(): ServiceResultLike;

  /** Restart the running service in place. */
  restart(): ServiceResultLike;

  /** Poll until the service is no longer running, or timeout. */
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;

  /** Remove the service definition from the OS. */
  deleteFile(): Promise<void>;

  /** Raw status output from the underlying tool, for downstream parsing. */
  describeStatus(): string;

  /**
   * Extract pid / last exit code from `describeStatus()` text. Returns
   * undefined for fields the platform doesn't expose or hasn't recorded yet.
   */
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: () => launchd.plistExists(profile),
    isRunning: () => launchd.isLoaded(profile),
    servicePath: () => launchAgentPlistPath(profile),
    install: () => launchd.writePlist(profile, runArgs),
    // A previous `stop` may have left the job disabled in launchd's override
    // DB, where it would stay dead through bootstrap. Always enable first.
    start: () => {
      launchd.enable(profile);
      return launchd.bootstrap(profile);
    },
    stop: () => launchd.bootout(profile),
    // bootout alone is session-scoped: the plist keeps RunAtLoad=true, so
    // launchd re-bootstraps the job at the next login. Pair it with an
    // explicit `disable` to actually match systemd's `disable --now`.
    stopAndDisableAutostart: () => {
      const out = launchd.bootout(profile);
      const disabled = launchd.disable(profile);
      return out.ok ? disabled : out;
    },
    disableAutostart: () => launchd.disable(profile),
    restart: () => launchd.kickstart(profile),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(profile, timeoutMs),
    deleteFile: () => launchd.deletePlist(profile),
    describeStatus: () => launchd.describeService(profile),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: () => systemd.unitExists(profile),
    isRunning: () => systemd.isActive(profile),
    servicePath: () => systemdUnitPath(profile),
    install: async () => {
      await systemd.writeUnit(profile, runArgs);
      // systemd needs daemon-reload after any unit file change.
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(profile),
    stop: () => systemd.stop(profile),
    stopAndDisableAutostart: () => systemd.disableAndStop(profile),
    disableAutostart: () => systemd.disable(profile),
    restart: () => systemd.restart(profile),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(profile, timeoutMs),
    deleteFile: async () => {
      await systemd.deleteUnit(profile);
      systemd.daemonReload();
    },
    describeStatus: () => systemd.describeService(profile),
    // `systemctl status` includes a "Main PID:" line and an "Active:"
    // line. There's no single "last exit code" field in the standard
    // output but the "Process: <pid> ExecStart=... status=<n>" line on
    // an inactive service exposes it.
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

/**
 * `schtasks /End` terminates the task instance (the hidden wrapper and the
 * launcher cmd) but NOT the detached node daemon underneath it. The daemon
 * survives as an orphan and keeps holding the profile runtime lock, so the
 * next `start` / `restart` finds the lock taken and exits.
 *
 * Killing the orphan is not enough on its own: on Windows the kill is a hard
 * TerminateProcess (there is no graceful SIGTERM), so proper-lockfile's
 * signal-exit cleanup never runs and its artifacts stay behind. A freshly
 * spawned daemon would fail to acquire the lock until those age out (30s in
 * `acquireRuntimeLock`) and — with restart-on-failure armed — retry that
 * doomed start every minute.
 *
 * So: kill only daemons that provably own this profile's lock, then make the
 * locks genuinely free again before returning.
 */
const LOCK_RELEASE_WAIT_MS = 40_000;
const LOCK_STALE_MS = 30_000; // must match the horizon used by acquireRuntimeLock

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make `targets` genuinely acquirable again.
 *
 * Waiting out proper-lockfile's staleness horizon would block `stop` / `start`
 * / `restart` for ~30s on every call. A lock whose recorded owner is no longer
 * alive is stale by definition, so its artifacts can be cleared right away; a
 * lock with a live owner is left strictly alone. The poll that follows is a
 * safety net for the cases we must not clear.
 */
async function ensureRuntimeLocksReleased(targets: string[], timeoutMs: number): Promise<void> {
  for (const target of targets) {
    const lock = await checkRuntimeLock(target, { staleMs: LOCK_STALE_MS });
    if (!lock.locked || lock.uncertain) continue;
    const ownerPid = lock.meta?.pid;
    if (ownerPid !== undefined && isAlive(ownerPid)) continue;
    await clearRuntimeLockArtifacts(target);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const locks = await Promise.all(
      targets.map((target) => checkRuntimeLock(target, { staleMs: LOCK_STALE_MS })),
    );
    if (locks.every((lock) => !lock.locked || lock.uncertain)) return;
    if (Date.now() >= deadline) return; // best-effort: let the caller surface the failure
    await delay(500);
  }
}

async function terminateProfileDaemons(
  profile: string,
  timeoutMs = 2000,
  lockWaitMs = LOCK_RELEASE_WAIT_MS,
): Promise<void> {
  const appPaths = resolveAppPaths({ rootDir: paths.rootDir, profile });
  const live = await liveEntriesForProfile(profile);

  if (live.length === 0) {
    // No daemon provably owns this profile any more, but a previous hard kill
    // can still have left runtime locks behind — either one would stall the
    // next start, so clear every lock this profile's entries could have owned.
    const appIds = readAndPrune()
      .filter((entry) => entry.profileName === profile)
      .map((entry) => entry.appId);
    await ensureRuntimeLocksReleased(
      [appPaths.profileLockFile, ...[...new Set(appIds)].map((appId) => appPaths.appLockFile(appId))],
      lockWaitMs,
    );
    return;
  }

  for (const entry of live) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isAlive(entry.pid)) {
      await delay(100);
    }
    if (isAlive(entry.pid)) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // raced with exit
      }
    }
    await ensureRuntimeLocksReleased(
      [appPaths.profileLockFile, appPaths.appLockFile(entry.appId)],
      lockWaitMs,
    );
  }
}

function makeSchtasksAdapter(profile: string, runArgs: string[]): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    fileExists: () => schtasks.isTaskRegistered(profile),
    isRunning: () => schtasks.isTaskRunning(profile),
    // Windows doesn't have a single "service file" — there's the task
    // registration (queryable via schtasks) and the launcher .cmd we wrote.
    // The task name is what the user would search for in Task Scheduler UI.
    servicePath: () => windowsTaskName(profile),
    install: async () => {
      const r = await schtasks.installTask(profile, runArgs);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    // Mirror launchd: a previous `stop` disabled the task, and a disabled
    // task refuses to run. Re-enable before starting it.
    //
    // Also reap any daemon still holding the profile lock: an earlier `/End`
    // (or the restart path, which degrades to `start` when the task instance
    // is already gone) leaves the daemon running as an orphan, and starting a
    // second one on top of it only fails on the runtime lock.
    start: async () => {
      schtasks.enableTask(profile);
      await terminateProfileDaemons(profile);
      return schtasks.runTask(profile);
    },
    // `/End` alone would leave the daemon orphaned (see helper above).
    stop: async () => {
      const r = schtasks.endTask(profile);
      await terminateProfileDaemons(profile);
      return r;
    },
    stopAndDisableAutostart: async () => {
      const r = schtasks.endAndDisable(profile);
      await terminateProfileDaemons(profile);
      return r;
    },
    disableAutostart: () => schtasks.disableTask(profile),
    // schtasks has no native /Restart: end, reap the daemon, then run again.
    restart: async () => {
      schtasks.endTask(profile);
      await terminateProfileDaemons(profile);
      await schtasks.waitUntilStopped(profile);
      return schtasks.runTask(profile);
    },
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(profile, timeoutMs),
    deleteFile: async () => {
      await schtasks.deleteTask(profile);
    },
    describeStatus: () => schtasks.describeTask(profile),
    parseStatus: (text) => ({
      // `Process ID: <n>` shows up in verbose listing only when task is running.
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      // `Last Result: <0|nonzero>` — `0` means last run succeeded.
      // Filter the `1056` ("task already running") and `267011` ("task hasn't
      // run") sentinels that aren't real exit codes.
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1],
    }),
  };
}

/**
 * Return the right adapter for the current platform, or null if this OS
 * isn't supported. Callers should null-check and surface a friendly error.
 *
 * `runArgs` are the CLI args the daemon launches with (e.g.
 * `['run', '--profile', 'claude']` for a classic per-profile service, or
 * `['run', '--web-ui']` for the supervisor service). They only matter for
 * `install()`; stop/status/etc. ignore them.
 */
export function getServiceAdapter(
  profile = 'claude',
  runArgs: string[] = ['run'],
): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(profile, runArgs);
  if (process.platform === 'linux') return makeSystemdAdapter(profile, runArgs);
  if (process.platform === 'win32') return makeSchtasksAdapter(profile, runArgs);
  return null;
}
