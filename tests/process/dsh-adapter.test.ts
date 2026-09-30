import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/dsh/adapter.js';
import { DEFAULT_DSH_MODEL, DEFAULT_DSH_PROVIDER } from '../../src/agent/dsh/patches.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('DshAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a headless json run, writes the provider overlay, and pipes the task to stdin', async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-fresh', cwd: 'ignored' },
        { type: 'status', phase: 'turn_start', turn: 1 },
        { type: 'status', phase: 'step_start', turn: 1, step: 1 },
        { type: 'text', text: 'hello user' },
        { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 42, outputTokens: 3 } },
        { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
        { type: 'final', text: 'hello user' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
      sandbox: 'danger-full-access',
      larkChannel: {
        profile: 'dsh',
        rootDir: join(fake.dir, 'channel-home'),
        configPath: join(fake.dir, 'channel-home', 'config.custom.json'),
        larkCliConfigDir: join(fake.dir, 'channel-home', 'profiles', 'dsh', 'lark-cli'),
      },
    });

    const runOptions = { runId: 'run-fresh', prompt: 'hello from lark', cwd };
    await adapter.prepareRun(runOptions);
    const run = adapter.run(runOptions);

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'session-fresh', cwd: 'ignored' },
      { type: 'text', delta: 'hello user' },
      { type: 'usage', inputTokens: 42, outputTokens: 3, cachedInputTokens: undefined, reasoningOutputTokens: undefined },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', sessionId: 'session-fresh', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    expect(await realpath(record.cwd)).toBe(cwd);
    expect(record.argv[0]).toBe('--profile');
    expect(record.argv[1]).toBe('headless');
    expect(record.argv.at(-1)).toBe('-');
    expect(record.argv).toContain('--json');
    // The prompt is never argv.
    expect(record.argv.join(' ')).not.toContain('hello from lark');

    // The generated overlays are the only channel for provider/model selection.
    const providerPatch = join(fake.dir, 'dsh', 'provider.patch.yml');
    // The provider overlay registers the route; the model overlay is what
    // actually points DSH's agent-default-model at it, so both are required.
    const defaultModelPatches = await modelPatchesIn(fake.dir);
    expect(defaultModelPatches).toHaveLength(1);
    const defaultModelPatch = join(fake.dir, 'dsh', defaultModelPatches[0] as string);
    expect(record.argv).toEqual([
      '--profile',
      'headless',
      '--patch',
      providerPatch,
      '--patch',
      defaultModelPatch,
      '--json',
      '-',
    ]);
    const providerYaml = await readFile(providerPatch, 'utf8');
    expect(providerYaml).toContain('id: llm-pi-ai');
    expect(providerYaml).toContain('oneapi:');
    expect(providerYaml).toContain('apiKeyEnv: "ONEAPI_API_KEY"');
    expect(providerYaml).toContain('baseURL: "https://oneapi.example.com/v1"');
    expect(providerYaml).toContain('id: "deepseek-v4.1-flash"');
    expect(await readFile(defaultModelPatch, 'utf8')).toContain(`model: "${DEFAULT_DSH_MODEL}"`);

    expect(record.stdin).toContain('lark-channel-bridge 运行约定');
    expect(record.stdin).toContain('__bridge_cb');
    expect(record.stdin).toContain('hello from lark');
    expect(record.stdin).not.toBe('hello from lark');
    expect(record.env).toMatchObject({
      DSH_PERMISSION_MODE: 'danger-full-access',
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'dsh',
    });
    expect(record.env.LARKSUITE_CLI_CONFIG_DIR).toContain('lark-cli');
  });

  it('pins the selected model with a second overlay applied after the provider', async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-m', cwd: 'ignored' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'ok' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    const runOptions = { runId: 'run-model', prompt: 'hi', cwd, model: 'GLM-5.2' };
    await adapter.prepareRun(runOptions);
    await collect(adapter.run(runOptions).events);

    const record = await readRecord(fake.recordPath);
    const modelPatches = await modelPatchesIn(fake.dir);
    expect(modelPatches).toHaveLength(1);
    const modelPatch = join(fake.dir, 'dsh', modelPatches[0] as string);
    expect(record.argv).toEqual([
      '--profile',
      'headless',
      '--patch',
      join(fake.dir, 'dsh', 'provider.patch.yml'),
      '--patch',
      modelPatch,
      '--json',
      '-',
    ]);
    const modelYaml = await readFile(modelPatch, 'utf8');
    expect(modelYaml).toContain('id: agent-default-model');
    expect(modelYaml).toContain('provider: "oneapi"');
    expect(modelYaml).toContain('model: "GLM-5.2"');
  });

  it('falls back to the provider default instead of emitting an unknown model', async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-x', cwd: 'ignored' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'ok' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    const runOptions = { runId: 'run-unknown', prompt: 'hi', cwd, model: 'gpt-9-imaginary' };
    await adapter.prepareRun(runOptions);
    await collect(adapter.run(runOptions).events);

    // An overlay for a model the provider does not declare would make DSH
    // fail outright, so the selection degrades to the provider default.
    const modelPatches = await modelPatchesIn(fake.dir);
    expect(modelPatches).toHaveLength(1);
    const modelPatch = join(fake.dir, 'dsh', modelPatches[0] as string);
    expect(await readFile(modelPatch, 'utf8')).toContain(`model: "${DEFAULT_DSH_MODEL}"`);
    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual([
      '--profile',
      'headless',
      '--patch',
      join(fake.dir, 'dsh', 'provider.patch.yml'),
      '--patch',
      modelPatch,
      '--json',
      '-',
    ]);
  });

  it('continues an existing session with --session-id', async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-existing', cwd: 'ignored' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'resumed' },
      ],
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    const runOptions = {
      runId: 'run-resume',
      prompt: 'second turn',
      cwd,
      sessionId: 'session-existing',
    };
    await adapter.prepareRun(runOptions);
    const events = await collect(adapter.run(runOptions).events);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toContain('--session-id');
    expect(record.argv[record.argv.indexOf('--session-id') + 1]).toBe('session-existing');
    expect(events.at(-1)).toEqual({
      type: 'done',
      sessionId: 'session-existing',
      terminationReason: 'normal',
    });
  });

  it('keeps a delivered answer when dsh exits non-zero during host teardown', async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-teardown', cwd: 'ignored' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
        { type: 'final', text: 'the answer' },
      ],
      exitCode: 3,
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    const runOptions = { runId: 'run-teardown', prompt: 'hi', cwd };
    await adapter.prepareRun(runOptions);
    const events = await collect(adapter.run(runOptions).events);

    expect(events).toEqual([
      { type: 'system', sessionId: 'session-teardown', cwd: 'ignored' },
      { type: 'final_text', content: 'the answer' },
      { type: 'done', sessionId: 'session-teardown', terminationReason: 'normal' },
    ]);
  });

  it('fails a non-zero exit that never completed a turn', async () => {
    const fake = await createFakeDsh({
      lines: [{ type: 'session', sessionId: 'session-broken', cwd: 'ignored' }],
      stderr: 'fatal: cannot reach provider\n',
      exitCode: 4,
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    const runOptions = { runId: 'run-broken', prompt: 'hi', cwd };
    await adapter.prepareRun(runOptions);
    const events = await collect(adapter.run(runOptions).events);

    expect(events).toEqual([
      { type: 'system', sessionId: 'session-broken', cwd: 'ignored' },
      { type: 'error', message: 'dsh exited with code 4: fatal: cannot reach provider', terminationReason: 'failed' },
    ]);
  });

  it('reports a missing binary through preflight instead of a bare spawn failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-test-'));
    cleanup.push(dir);
    const adapter = new DshAdapter({
      binary: join(dir, 'definitely-not-installed.cmd'),
      profileStateDir: dir,
      provider: DEFAULT_DSH_PROVIDER,
    });

    expect(await adapter.isAvailable()).toBe(false);
    await expect(
      adapter.prepareRun({ runId: 'run-missing', prompt: 'hi', cwd: dir }),
    ).rejects.toMatchObject({
      diagnostic: { code: 'agent-binary-not-found', agentId: 'dsh', agentName: 'DeepSeek Harness' },
    });
  });

  it(
    'stops a running turn and reports it as interrupted rather than failed',
    async () => {
    const fake = await createFakeDsh({
      lines: [
        { type: 'session', sessionId: 'session-stop', cwd: 'ignored' },
        { type: 'status', phase: 'turn_start', turn: 1 },
      ],
      sleepMs: 60_000,
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const adapter = new DshAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      provider: DEFAULT_DSH_PROVIDER,
      stopGraceMs: 4000,
    });

    const runOptions = { runId: 'run-stop', prompt: 'long job', cwd };
    await adapter.prepareRun(runOptions);
    const run: AgentRun = adapter.run(runOptions);
    const collected = collect(run.events);
    await sleep(600);

    const startedAt = Date.now();
    await run.stop();
    const events = await collected;
    const elapsed = Date.now() - startedAt;

    // The Windows shim (.CMD wrapping node) is killed as a tree, so the stop
    // must settle on its own rather than waiting out the grace period.
    expect(elapsed).toBeLessThan(3500);
    expect(events.at(-1)).toEqual({
      type: 'done',
      sessionId: 'session-stop',
      terminationReason: 'interrupted',
    });
    expect(await run.waitForExit(2000)).toBe(true);
    },
    20_000,
  );
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function modelPatchesIn(profileStateDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(profileStateDir, 'dsh'));
    return entries.filter((entry) => entry.startsWith('model-') && entry.endsWith('.patch.yml')).sort();
  } catch {
    return [];
  }
}

async function readRecord(path: string): Promise<{
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string | undefined>;
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    cwd: string;
    stdin: string;
    env: Record<string, string | undefined>;
  };
}

/**
 * A fake `dsh` launcher.
 *
 * On Windows it mirrors the real thing: a `.CMD` shim that runs a script, which
 * is precisely the shape the adapter has to special-case when stopping. On
 * other platforms the script is the executable directly.
 */
async function createFakeDsh(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-adapter-test-'));
  const recordPath = join(dir, 'record.json');
  const body = [
    'import { writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'if (argv.includes("--version")) { console.log("dsh 0.2.0-rc.2"); process.exit(0); }',
    'let stdin = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '    argv,',
    '    cwd: process.cwd(),',
    '    stdin,',
    '    env: {',
    '      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,',
    '      DSH_HOME: process.env.DSH_HOME,',
    '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
    '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
    '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
    '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
    '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
    '    },',
    '  }));',
    `  const lines = ${JSON.stringify(options.lines)};`,
    '  for (const line of lines) console.log(JSON.stringify(line));',
    options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
    `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.sleepMs ?? 0});`,
    '});',
  ]
    .filter(Boolean)
    .join('\n');

  if (process.platform === 'win32') {
    const script = join(dir, 'fake-dsh.mjs');
    await writeFile(script, body, 'utf8');
    const shim = join(dir, 'fake-dsh.CMD');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return { path: shim, dir, recordPath };
  }

  const executable = join(dir, 'fake-dsh');
  await writeFile(executable, `#!${process.execPath}\n${body}`, { encoding: 'utf8', mode: 0o755 });
  await chmod(executable, 0o755);
  return { path: executable, dir, recordPath };
}
