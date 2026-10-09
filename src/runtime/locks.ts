import { chmod, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind } from '../config/profile-schema';

export type RuntimeLockKind = 'profile' | 'app';

export interface AcquiredRuntimeLock {
  kind: RuntimeLockKind;
  target: string;
  release(): Promise<void>;
}

export interface RuntimeLockMeta {
  kind: RuntimeLockKind;
  target: string;
  profile: string;
  agentKind: AgentKind;
  appId?: string;
  pid: number;
  startedAt: string;
}

export class RuntimeLockConflictError extends Error {
  constructor(
    readonly kind: RuntimeLockKind,
    readonly target: string,
    readonly meta: RuntimeLockMeta | undefined,
    cause: unknown,
  ) {
    super(`runtime ${kind} lock is already held: ${target}`);
    this.name = 'RuntimeLockConflictError';
    this.cause = cause;
  }
}

export async function withProfileAndAppLocks<T>(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
  fn: (locks: AcquiredRuntimeLock[]) => Promise<T> | T,
): Promise<T> {
  const acquired: AcquiredRuntimeLock[] = [];
  try {
    acquired.push(
      await acquireRuntimeLock({
        kind: 'profile',
        target: paths.profileLockFile,
        profile: paths.profile,
        agentKind,
      }),
    );
    acquired.push(
      await acquireRuntimeLock({
        kind: 'app',
        target: paths.appLockFile(appId),
        profile: paths.profile,
        agentKind,
        appId,
      }),
    );
    return await fn([...acquired]);
  } finally {
    for (const lock of acquired.reverse()) {
      await lock.release().catch(() => {});
    }
  }
}

export async function acquireAppRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'app',
    target: paths.appLockFile(appId),
    profile: paths.profile,
    agentKind,
    appId,
  });
}

export async function acquireProfileRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile'>,
  agentKind: AgentKind,
): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'profile',
    target: paths.profileLockFile,
    profile: paths.profile,
    agentKind,
  });
}

export function runtimeLockMetaFile(target: string): string {
  return `${target}.meta.json`;
}

/**
 * Remove the on-disk artifacts a lock leaves behind: the `<target>.lock`
 * directory (proper-lockfile uses it as an atomic marker and its mtime as the
 * freshness signal) plus our metadata sidecar.
 *
 * The caller must have established that the lock's owner is gone — this only
 * deletes files, it does not check liveness. It exists because a lock whose
 * owner was hard-killed is stale by definition, while waiting for the
 * staleness horizon to elapse (30s in `acquireRuntimeLock`) would stall the
 * next start for that long.
 */
export async function clearRuntimeLockArtifacts(target: string): Promise<void> {
  await rm(`${target}.lock`, { recursive: true, force: true });
  await rm(runtimeLockMetaFile(target), { force: true });
}

export async function readRuntimeLockMeta(target: string): Promise<RuntimeLockMeta | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimeLockMetaFile(target), 'utf8')) as unknown;
    return isRuntimeLockMeta(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function checkRuntimeLock(
  target: string,
  opts: { staleMs?: number } = {},
): Promise<{
  locked: boolean;
  meta?: RuntimeLockMeta;
  uncertain?: boolean;
  error?: string;
}> {
  try {
    // NB: proper-lockfile's `check` spreads options over its defaults, so an
    // explicit `stale: undefined` would silently become 2s — only pass it when
    // the caller asked for a specific horizon.
    const locked = await lockfile.check(
      target,
      opts.staleMs === undefined
        ? { realpath: false }
        : { realpath: false, stale: opts.staleMs },
    );
    if (!locked) return { locked: false };
    const meta = await readRuntimeLockMeta(target);
    if (!meta) {
      return { locked: true, uncertain: true, error: 'missing-or-invalid-runtime-lock-meta' };
    }
    return { locked: true, meta };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { locked: false };
    return {
      locked: true,
      uncertain: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function acquireRuntimeLock(
  meta: Omit<RuntimeLockMeta, 'pid' | 'startedAt'>,
): Promise<AcquiredRuntimeLock> {
  await mkdir(dirname(meta.target), { recursive: true });
  await writeFile(meta.target, '', { flag: 'a', mode: 0o600 });
  await chmod(meta.target, 0o600);

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(meta.target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
    });
  } catch (err) {
    throw new RuntimeLockConflictError(meta.kind, meta.target, await readRuntimeLockMeta(meta.target), err);
  }

  const fullMeta: RuntimeLockMeta = {
    ...meta,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const metaFile = runtimeLockMetaFile(meta.target);
  await writeFile(metaFile, `${JSON.stringify(fullMeta, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(metaFile, 0o600);

  return {
    kind: meta.kind,
    target: meta.target,
    async release() {
      await unlink(metaFile).catch(() => {});
      await release();
    },
  };
}

function isRuntimeLockMeta(value: unknown): value is RuntimeLockMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<RuntimeLockMeta>;
  return (
    (meta.kind === 'profile' || meta.kind === 'app') &&
    typeof meta.target === 'string' &&
    typeof meta.profile === 'string' &&
    (meta.agentKind === 'claude' || meta.agentKind === 'codex' || meta.agentKind === 'dsh') &&
    typeof meta.pid === 'number' &&
    typeof meta.startedAt === 'string' &&
    (meta.appId === undefined || typeof meta.appId === 'string')
  );
}
