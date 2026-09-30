import type { SandboxMode } from '../../config/profile-schema';

/**
 * DSH's permission vocabulary is byte-identical to the bridge's sandbox
 * vocabulary, so this is a validated pass-through rather than a translation
 * table. Keeping the list here (instead of trusting the caller) means a future
 * divergence between the two vocabularies fails loudly instead of silently
 * widening access.
 */
export const DSH_PERMISSION_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

export type DshPermissionMode = (typeof DSH_PERMISSION_MODES)[number];

export function toDshPermissionMode(sandbox: SandboxMode): DshPermissionMode {
  for (const mode of DSH_PERMISSION_MODES) {
    if (mode === sandbox) return mode;
  }
  throw new Error(`unsafe sandbox mode: ${sandbox}`);
}

export interface BuildDshArgsInput {
  /** DSH profile whose app answers the task; `headless` answers one and exits. */
  profile: string;
  /** Patch overlays applied after the profile layer, in order. */
  patches?: readonly string[];
  /** Continue an existing DSH session instead of starting a new one. */
  sessionId?: string;
}

/**
 * Build the argv for one run.
 *
 * Three things are deliberately *not* flags:
 *
 *  - **the working directory**: DSH derives the session workspace root and the
 *    sandbox's authorized root from the child's cwd, so the adapter spawns in
 *    `AgentRunOptions.cwd` rather than passing a path. This is also what makes
 *    the bridge's `/cd` and `/ws` work unchanged.
 *  - **the permission mode**: DSH reads `DSH_PERMISSION_MODE` from the
 *    environment. See {@link toDshPermissionMode}.
 *  - **the task**: it arrives on stdin. `-` makes DSH read it to EOF, which
 *    keeps long multi-line bridge prompts (system prompt + context + user
 *    message) off the command line, where Windows would truncate them.
 */
export function buildDshArgs(input: BuildDshArgsInput): string[] {
  return [
    '--profile',
    input.profile,
    ...(input.patches ?? []).flatMap((patch) => ['--patch', patch]),
    '--json',
    ...(input.sessionId ? ['--session-id', input.sessionId] : []),
    '-',
  ];
}
