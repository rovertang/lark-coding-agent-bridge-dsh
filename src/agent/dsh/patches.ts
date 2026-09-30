import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DshProviderModel {
  /** Model id as the provider expects it on the wire. */
  id: string;
  /** Label DSH shows for the model; defaults to `id`. */
  name?: string;
}

/**
 * A provider declaration for the `llm-pi-ai` plugin.
 *
 * DSH resolves `apiKeyEnv` through its own credential store, so the bridge
 * never reads or holds the secret: a credential the DSH desktop profile already
 * stores (e.g. `ONEAPI_API_KEY` in `$DSH_HOME/.credentials.yaml`) is reused
 * as-is, so the profile names a provider rather than copying a key.
 */
export interface DshProviderConfig {
  id: string;
  apiKeyEnv: string;
  /** DSH provider API family, e.g. `openai-completions`. */
  api: string;
  baseURL: string;
  /**
   * Model pinned for runs that do not select one. See
   * {@link effectiveDshModel} for why a default is always applied.
   */
  defaultModel?: string;
  models: DshProviderModel[];
}

/** The DSH app that answers one task and exits. */
export const DSH_DEFAULT_PROFILE = 'headless';

/**
 * The provider shipped as a starting point for a new profile.
 *
 * This is a **placeholder**: `oneapi.example.com` is not a real gateway and
 * `ONEAPI_API_KEY` is not a real credential. Point `id`, `baseURL`, and
 * `apiKeyEnv` at your own OpenAI-compatible gateway before starting a run, and
 * make sure the credential name exists in DSH's own credential store.
 */
export const DEFAULT_DSH_PROVIDER: DshProviderConfig = {
  id: 'oneapi',
  apiKeyEnv: 'ONEAPI_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://oneapi.example.com/v1',
  defaultModel: 'deepseek-v4.1-flash',
  models: [
    { id: 'deepseek-v4.1-flash' },
    { id: 'deepseek-v4-flash-fp8' },
    { id: 'deepseek-v4-flash-fp8-volcano' },
    { id: 'GLM-5.2' },
    { id: 'GLM-5.2-Volcengine' },
    { id: 'glm-5.3-flash' },
  ],
};

/**
 * The default provider's default model. Must be one of
 * {@link DshProviderConfig.models}.
 */
export const DEFAULT_DSH_MODEL = DEFAULT_DSH_PROVIDER.defaultModel as string;

export interface EnsureDshPatchesInput {
  /** Directory that holds the generated overlays (the profile state dir). */
  dir: string;
  provider: DshProviderConfig;
  /** Selected model. Ignored unless the provider declares it. */
  model?: string;
  /** Config-supplied overlays, appended after the generated ones. */
  extraPatches?: readonly string[];
}

export interface DshPatchSet {
  /** Overlay paths in application order, oldest layer first. */
  patches: string[];
  providerPatch: string;
  modelPatch?: string;
}

/**
 * Resolve a model selection against the provider's catalogue.
 *
 * Returning `undefined` for an unknown id is deliberate: the `/model` picker's
 * option list is static, so a stale or hand-edited preference must degrade to
 * "use the profile default" rather than emit an overlay that makes DSH fail
 * with an unknown-model error.
 */
export function resolveDshModel(
  provider: DshProviderConfig,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  return provider.models.some((entry) => entry.id === model) ? model : undefined;
}

/**
 * The model this run should pin.
 *
 * A default is **always** applied, even when the run selects nothing. Declaring
 * the provider is not enough to make DSH use it: `llm-pi-ai` registers the
 * declared provider as an *additional* route while `agent-default-model` still
 * points at DSH's built-in `deepseek-official`, so a run that only carries the
 * provider overlay fails with `MISSING_CREDENTIAL` — verified against a real
 * headless run. The generated `agent-default-model` overlay is what actually
 * routes the task.
 */
export function effectiveDshModel(
  provider: DshProviderConfig,
  model: string | undefined,
): string | undefined {
  return resolveDshModel(provider, model) ?? provider.defaultModel ?? provider.models[0]?.id;
}

/**
 * Write (or refresh) the generated overlays and return their paths.
 *
 * Two layers are produced:
 *
 *  1. a provider overlay that declares the configured provider and its models, and
 *  2. a model overlay that pins `agent-default-model` to the effective model
 *     (see {@link effectiveDshModel}).
 *
 * They are written into the profile's state directory rather than shipped as
 * package assets, so the built `dist/` needs no extra files and the content is
 * always derived from the live profile config.
 */
export async function ensureDshPatches(input: EnsureDshPatchesInput): Promise<DshPatchSet> {
  await mkdir(input.dir, { recursive: true });

  const providerPatch = join(input.dir, 'provider.patch.yml');
  await writeIfChanged(providerPatch, renderProviderPatch(input.provider));

  const patches = [providerPatch];
  const model = effectiveDshModel(input.provider, input.model);
  let modelPatch: string | undefined;
  if (model) {
    modelPatch = join(input.dir, `model-${shortHash(model)}.patch.yml`);
    await writeIfChanged(modelPatch, renderModelPatch(input.provider.id, model));
    patches.push(modelPatch);
  }
  patches.push(...(input.extraPatches ?? []));

  return { patches, providerPatch, ...(modelPatch ? { modelPatch } : {}) };
}

/**
 * Render the provider overlay.
 *
 * `llm-pi-ai` and `agent-default-model` are both already present in the
 * shipped `headless` bundle, and DSH applies a patch entry as an id-targeted
 * config override, so naming them here augments rather than duplicates them.
 */
export function renderProviderPatch(provider: DshProviderConfig): string {
  return [
    '# Generated by lark-channel-bridge (dsh agent adapter) — do not edit.',
    '# Rewritten from the profile config whenever the bridge starts a run.',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    `      ${yamlKey(provider.id)}:`,
    `        apiKeyEnv: ${yamlScalar(provider.apiKeyEnv)}`,
    `        api: ${yamlScalar(provider.api)}`,
    `        baseURL: ${yamlScalar(provider.baseURL)}`,
    '        models:',
    ...provider.models.flatMap((model) => [
      `          - id: ${yamlScalar(model.id)}`,
      `            name: ${yamlScalar(model.name ?? model.id)}`,
    ]),
    '',
  ].join('\n');
}

export function renderModelPatch(providerId: string, modelId: string): string {
  return [
    '# Generated by lark-channel-bridge (dsh agent adapter) — do not edit.',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${yamlScalar(providerId)}`,
    `    model: ${yamlScalar(modelId)}`,
    '',
  ].join('\n');
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Bare when the id is a plain YAML key, quoted otherwise. */
function yamlKey(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : yamlScalar(value);
}

function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
