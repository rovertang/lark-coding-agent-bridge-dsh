import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DSH_DEFAULT_PROFILE, DEFAULT_DSH_PROVIDER } from '../agent/dsh/patches';
import type { DshConfig } from '../agent/dsh/config';
import { AgentPreflightError } from '../agent/preflight';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import { resolveExecutablePath } from './agent-detection';

export interface BootstrapProfileInput {
  agentKind: AgentKind;
  accounts: AppConfig['accounts'];
  preferences?: AppConfig['preferences'];
  secrets?: AppConfig['secrets'];
  workspace?: string;
  defaultWorkspace?: string;
  codexBinaryPath?: string;
  dshBinaryPath?: string;
  profileDir?: string;
}

export async function createBootstrapProfileConfig(
  input: BootstrapProfileInput,
): Promise<ProfileConfig> {
  const workspace = input.workspace
    ? await resolveBootstrapWorkspace(input.workspace)
    : input.defaultWorkspace
      ? await ensureManagedDefaultWorkspace(input.defaultWorkspace)
      : undefined;
  const codex =
    input.agentKind === 'codex'
      ? await createBootstrapCodexConfig(input.codexBinaryPath)
      : undefined;
  const dsh =
    input.agentKind === 'dsh' ? await createBootstrapDshConfig(input.dshBinaryPath) : undefined;
  const profile = createDefaultProfileConfig({
    agentKind: input.agentKind,
    accounts: input.accounts,
    preferences: input.preferences,
    secrets: input.secrets,
    ...(codex ? { codex } : {}),
    ...(dsh ? { dsh } : {}),
  });
  if (workspace) {
    profile.workspaces = {
      ...profile.workspaces,
      default: workspace,
    };
  }
  if (input.profileDir && profile.codex?.inheritCodexHome === false) {
    await mkdir(join(input.profileDir, 'codex-home'), { recursive: true });
  }
  return profile;
}

export async function resolveBootstrapWorkspace(workspace: string): Promise<string> {
  const resolved = await resolveWorkingDirectory(workspace);
  if (!resolved.ok) throw new Error(resolved.userVisible);
  return resolved.cwdRealpath;
}

async function ensureManagedDefaultWorkspace(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
}

export async function createBootstrapCodexConfig(binaryPath: string | undefined) {
  const command = binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: bootstrapBinaryErrorCode(errno),
      agentId: 'codex',
      agentName: 'Codex CLI',
      command,
      binaryPath: command,
      errno,
    });
  }
  return { binaryPath: resolvedBinary };
}

/**
 * Resolve the DSH launcher for a new profile.
 *
 * The provider declaration is recorded in the profile rather than read from the
 * DSH install, so an existing DSH credential (resolved by DSH itself through
 * `apiKeyEnv`) is shared without the bridge ever handling the secret.
 */
export async function createBootstrapDshConfig(binaryPath: string | undefined): Promise<DshConfig> {
  const command = binaryPath ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh';
  let resolvedBinary: string;
  try {
    resolvedBinary = await resolveExecutablePath(command);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    throw new AgentPreflightError({
      code: bootstrapBinaryErrorCode(errno),
      agentId: 'dsh',
      agentName: 'DeepSeek Harness',
      command,
      binaryPath: command,
      errno,
    });
  }
  return {
    binaryPath: resolvedBinary,
    profile: DSH_DEFAULT_PROFILE,
    provider: DEFAULT_DSH_PROVIDER,
  };
}

function bootstrapBinaryErrorCode(errno: string | undefined) {
  if (errno === 'EACCES' || errno === 'EPERM') return 'agent-binary-not-executable';
  if (errno === 'ELOOP' || errno === 'ENOTDIR' || errno === 'EINVAL') {
    return 'agent-binary-resolve-failed';
  }
  return 'agent-binary-not-found';
}
