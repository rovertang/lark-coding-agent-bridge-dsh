import {
  DEFAULT_DSH_PROVIDER,
  type DshProviderConfig,
  type DshProviderModel,
} from './patches';

/**
 * Per-profile configuration for the DeepSeek Harness backend.
 *
 * `binaryPath` is the only required field: everything else has a working
 * default, so a profile created against a `dsh` that is not on PATH needs only
 * the resolved shim path recorded.
 */
export interface DshConfig {
  /** The `dsh` launcher: a `.cmd` shim on Windows, a shebang script elsewhere. */
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  /** DSH profile to boot; see {@link DSH_DEFAULT_PROFILE}. */
  profile?: string;
  /**
   * Provider declared by the generated overlay. Defaults to the shipped
   * placeholder provider; see {@link DEFAULT_DSH_PROVIDER}.
   */
  provider?: DshProviderConfig;
  /**
   * Extra `--patch` overlays applied after the generated ones, for a profile
   * that needs further DSH tuning (tools mode, extra plugins, …).
   */
  patches?: string[];
  /** `DSH_HOME` override. When omitted DSH inherits the ambient one. */
  dshHome?: string;
}

export function normalizeDshConfig(input: unknown): DshConfig {
  const raw = (input ?? {}) as Partial<DshConfig> & { binaryPath?: unknown };
  const binaryPath = typeof raw.binaryPath === 'string' ? raw.binaryPath.trim() : '';
  if (!binaryPath) {
    throw new Error('dsh profile requires dsh.binaryPath');
  }

  const patches = Array.isArray(raw.patches)
    ? raw.patches.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];

  return {
    binaryPath,
    ...(typeof raw.realpath === 'string' ? { realpath: raw.realpath } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}),
    ...(typeof raw.owner === 'number' ? { owner: raw.owner } : {}),
    ...(typeof raw.mode === 'number' ? { mode: raw.mode } : {}),
    profile: nonEmpty(raw.profile) ?? 'headless',
    provider: normalizeDshProvider(raw.provider),
    ...(patches.length ? { patches } : {}),
    ...(nonEmpty(raw.dshHome) ? { dshHome: raw.dshHome } : {}),
  };
}

function normalizeDshProvider(input: unknown): DshProviderConfig {
  const raw = (input ?? {}) as Partial<DshProviderConfig>;
  const models = normalizeDshModels(raw.models);
  const defaultModel = nonEmpty(raw.defaultModel);
  return {
    id: nonEmpty(raw.id) ?? DEFAULT_DSH_PROVIDER.id,
    apiKeyEnv: nonEmpty(raw.apiKeyEnv) ?? DEFAULT_DSH_PROVIDER.apiKeyEnv,
    api: nonEmpty(raw.api) ?? DEFAULT_DSH_PROVIDER.api,
    baseURL: nonEmpty(raw.baseURL) ?? DEFAULT_DSH_PROVIDER.baseURL,
    ...(defaultModel ? { defaultModel } : {}),
    models: models.length ? models : DEFAULT_DSH_PROVIDER.models,
  };
}

function normalizeDshModels(input: unknown): DshProviderModel[] {
  if (!Array.isArray(input)) return [];
  const models: DshProviderModel[] = [];
  for (const entry of input) {
    const candidate = (entry ?? {}) as Partial<DshProviderModel>;
    const id = nonEmpty(candidate.id);
    if (!id) continue;
    const name = nonEmpty(candidate.name);
    models.push(name ? { id, name } : { id });
  }
  return models;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
