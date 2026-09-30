import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'dsh';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'dsh-session';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * DeepSeek Harness behaves like Claude rather than Codex for session handling:
 * DSH owns an opaque `session-<uuid>` that is replayed verbatim with
 * `--session-id`, so the bridge stores a session id (not a thread id).
 *
 * `supportsNativeHistory` stays false — DSH does persist its own sessions, but
 * the bridge cannot enumerate or re-render them, so it offers its own
 * per-chat session instead of pretending to browse DSH's history.
 */
export function dshCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'dsh',
    sessionKind: 'dsh-session',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Whether an agent resumes by replaying an opaque session id rather than a
 * thread id. Claude and DeepSeek Harness both do; only Codex is thread-based.
 *
 * Session continuity, the session catalog, and `/resume` all branch on this, so
 * it lives here rather than being re-derived as `agentId === 'claude'` — which
 * silently disabled resumption for every agent added afterwards.
 */
export function isSessionIdAgent(agentId: AgentCapabilityId): boolean {
  return agentId !== 'codex';
}

/**
 * The one place that maps a profile's agent kind to its capability. Every
 * caller used to re-derive this with an `agentKind === 'codex' ? … : …`
 * ternary, which silently mislabelled any new agent as Claude.
 */
export function capabilityFor(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions'>,
): AgentCapability {
  switch (profile.agentKind) {
    case 'codex':
      return codexCapability(profile);
    case 'dsh':
      return dshCapability(profile);
    default:
      return claudeCapability(profile);
  }
}
