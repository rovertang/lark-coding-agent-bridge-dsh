import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DSH_MODEL,
  DEFAULT_DSH_PROVIDER,
  effectiveDshModel,
  ensureDshPatches,
  renderModelPatch,
  renderProviderPatch,
  resolveDshModel,
} from '../../../src/agent/dsh/patches.js';

describe('Dsh patch overlays', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
    );
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patches-test-'));
    cleanup.push(dir);
    return dir;
  }

  it('declares the provider the DSH credential store already holds', () => {
    const yaml = renderProviderPatch(DEFAULT_DSH_PROVIDER);
    expect(yaml).toContain('- id: llm-pi-ai');
    expect(yaml).toContain('name: "@deepseek-ai/dsh-llm-pi-ai"');
    expect(yaml).toContain('      oneapi:');
    expect(yaml).toContain('api: "openai-completions"');
    expect(yaml).toContain('apiKeyEnv: "ONEAPI_API_KEY"');
    expect(yaml).toContain('baseURL: "https://oneapi.example.com/v1"');
    expect(yaml).toContain('- id: "deepseek-v4.1-flash"');
    // Every model needs a name, or DSH's picker shows the id only.
    expect(yaml).toContain('name: "deepseek-v4.1-flash"');
    expect(yaml.endsWith('\n')).toBe(true);
  });

  it('pins the default model through the agent-default-model plugin', () => {
    const yaml = renderModelPatch('oneapi', 'GLM-5.2');
    expect(yaml).toContain('- id: agent-default-model');
    expect(yaml).toContain('name: "@deepseek-ai/dsh-agent-default-model"');
    expect(yaml).toContain('provider: "oneapi"');
    expect(yaml).toContain('model: "GLM-5.2"');
  });

  it('writes provider first and the model overlay last so it wins', async () => {
    const dir = await tempDir();
    const set = await ensureDshPatches({
      dir,
      provider: DEFAULT_DSH_PROVIDER,
      model: 'GLM-5.2',
      extraPatches: ['/extra/tuning.yml'],
    });
    expect(set.patches).toEqual([
      join(dir, 'provider.patch.yml'),
      set.modelPatch,
      '/extra/tuning.yml',
    ]);
    expect(await readFile(join(dir, 'provider.patch.yml'), 'utf8')).toContain('oneapi:');
    expect(await readFile(set.modelPatch as string, 'utf8')).toContain('model: "GLM-5.2"');
  });

  it('pins the provider default even when the run selects no model', async () => {
    const dir = await tempDir();
    const set = await ensureDshPatches({ dir, provider: DEFAULT_DSH_PROVIDER });
    // A run carrying only the provider overlay still routes to DSH's built-in
    // `deepseek-official` default and dies with MISSING_CREDENTIAL, so the
    // model overlay is not optional.
    expect(set.modelPatch).toBeDefined();
    expect(await readFile(set.modelPatch as string, 'utf8')).toContain(
      `model: "${DEFAULT_DSH_MODEL}"`,
    );
    expect(set.patches).toEqual([join(dir, 'provider.patch.yml'), set.modelPatch]);
  });

  it('omits the model overlay only when the provider has no models at all', async () => {
    const dir = await tempDir();
    const set = await ensureDshPatches({
      dir,
      provider: { ...DEFAULT_DSH_PROVIDER, models: [], defaultModel: undefined },
    });
    expect(set.modelPatch).toBeUndefined();
    expect(set.patches).toEqual([join(dir, 'provider.patch.yml')]);
    expect((await readdir(dir)).filter((f) => f.startsWith('model-'))).toEqual([]);
  });

  it('leaves an up-to-date overlay untouched and rewrites a stale one', async () => {
    const dir = await tempDir();
    const providerPatch = join(dir, 'provider.patch.yml');
    await ensureDshPatches({ dir, provider: DEFAULT_DSH_PROVIDER });
    const first = await readFile(providerPatch, 'utf8');

    // Rewriting identical content must not churn the file: DSH watches patches
    // and a needless mtime bump is pure noise.
    await writeFile(providerPatch, first, 'utf8');
    const before = (await readdir(dir)).sort();
    await ensureDshPatches({ dir, provider: DEFAULT_DSH_PROVIDER });
    expect(await readFile(providerPatch, 'utf8')).toBe(first);
    expect((await readdir(dir)).sort()).toEqual(before);

    // A changed provider is picked up.
    await ensureDshPatches({
      dir,
      provider: { ...DEFAULT_DSH_PROVIDER, baseURL: 'https://elsewhere.example/v1' },
    });
    const updated = await readFile(providerPatch, 'utf8');
    expect(updated).toContain('baseURL: "https://elsewhere.example/v1"');
    expect(updated).not.toBe(first);
  });

  it('accepts a customized provider catalogue', async () => {
    const dir = await tempDir();
    const set = await ensureDshPatches({
      dir,
      provider: {
        id: 'local',
        apiKeyEnv: 'LOCAL_KEY',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:11434/v1',
        models: [{ id: 'qwen3-coder', name: 'Qwen3 Coder' }],
      },
      model: 'qwen3-coder',
    });
    const yaml = await readFile(set.providerPatch, 'utf8');
    expect(yaml).toContain('      local:');
    expect(yaml).toContain('name: "Qwen3 Coder"');
    expect(await readFile(set.modelPatch as string, 'utf8')).toContain('provider: "local"');
  });

  it('resolves a model only when the provider declares it', () => {
    expect(resolveDshModel(DEFAULT_DSH_PROVIDER, 'GLM-5.2')).toBe('GLM-5.2');
    expect(resolveDshModel(DEFAULT_DSH_PROVIDER, 'not-a-model')).toBeUndefined();
    expect(resolveDshModel(DEFAULT_DSH_PROVIDER, undefined)).toBeUndefined();
    expect(resolveDshModel(DEFAULT_DSH_PROVIDER, '')).toBeUndefined();
  });

  it('falls back to the declared default for an unknown or absent selection', () => {
    expect(effectiveDshModel(DEFAULT_DSH_PROVIDER, 'GLM-5.2')).toBe('GLM-5.2');
    expect(effectiveDshModel(DEFAULT_DSH_PROVIDER, 'not-a-model')).toBe(DEFAULT_DSH_MODEL);
    expect(effectiveDshModel(DEFAULT_DSH_PROVIDER, undefined)).toBe(DEFAULT_DSH_MODEL);
    // Without a declared default the first catalogue entry is the fallback.
    expect(
      effectiveDshModel(
        { ...DEFAULT_DSH_PROVIDER, defaultModel: undefined, models: [{ id: 'only-model' }] },
        undefined,
      ),
    ).toBe('only-model');
    expect(
      effectiveDshModel(
        { ...DEFAULT_DSH_PROVIDER, defaultModel: undefined, models: [] },
        undefined,
      ),
    ).toBeUndefined();
  });

  it('quotes a provider id that is not a plain YAML key', () => {
    expect(renderProviderPatch({ ...DEFAULT_DSH_PROVIDER, id: 'a:b' })).toContain('      "a:b":');
  });
});
