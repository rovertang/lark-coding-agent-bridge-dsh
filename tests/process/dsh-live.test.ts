import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DshAdapter } from '../../src/agent/dsh/adapter.js';
import { DEFAULT_DSH_PROVIDER } from '../../src/agent/dsh/patches.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * End-to-end proof against a real DeepSeek Harness install.
 *
 * Opt-in because it spends real model tokens and needs a working credential:
 *
 * ```powershell
 * $env:LARK_CHANNEL_DSH_LIVE = '1'
 * $env:LARK_CHANNEL_DSH_BIN  = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
 * pnpm test:process -- dsh-live
 * ```
 *
 * The reference adapter tests use a fake launcher and cover the contract; this
 * file exists to catch the things a fake cannot — a DSH release changing its
 * event vocabulary, its argv parsing, or its session resumption.
 */
const live = process.env.LARK_CHANNEL_DSH_LIVE === '1' && Boolean(process.env.LARK_CHANNEL_DSH_BIN);

const describeLive = live ? describe : describe.skip;

describeLive('DshAdapter against a real DSH install', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
  });

  it(
    'answers a task and resumes the same DSH session on the next run',
    async () => {
      const binary = process.env.LARK_CHANNEL_DSH_BIN as string;
      const dir = await mkdtemp(join(tmpdir(), 'dsh-live-'));
      dirs.push(dir);
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-live-ws-'));
      dirs.push(cwd);

      const adapter = new DshAdapter({
        binary,
        profileStateDir: dir,
        provider: DEFAULT_DSH_PROVIDER,
        // Windows workspace-write provisioning can be refused by the ACL, and
        // the desktop profile this shares a provider with already defaults here.
        sandbox: 'danger-full-access',
      });

      // The preflight is what turns a missing/broken install into a readable
      // diagnostic instead of a bare spawn failure.
      expect(await adapter.isAvailable()).toBe(true);

      const first = { runId: 'live-1', prompt: '记住暗号 BANANA-42。只回复 ACK。', cwd };
      await adapter.prepareRun(first);
      const firstRun = adapter.run(first);
      const firstEvents = await collect(firstRun.events);

      expect(firstRun.runId).toBe('live-1');
      const sessionId = sessionOf(firstEvents);
      expect(sessionId).toMatch(/^session-/);
      expect(firstEvents.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      expect(finalText(firstEvents)).toMatch(/ACK/i);

      // A resumed run only answers correctly if --session-id actually reached
      // DSH and landed on the same session.
      const second = {
        runId: 'live-2',
        prompt: '暗号是什么？只回复暗号本身。',
        cwd,
        sessionId: sessionId as string,
      };
      await adapter.prepareRun(second);
      const secondEvents = await collect(adapter.run(second).events);

      expect(secondEvents.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      expect(finalText(secondEvents)).toContain('BANANA-42');
    },
    240_000,
  );

  it(
    'pins a selected model through the generated overlay without touching the DSH profile',
    async () => {
      const binary = process.env.LARK_CHANNEL_DSH_BIN as string;
      const dir = await mkdtemp(join(tmpdir(), 'dsh-live-model-'));
      dirs.push(dir);
      const cwd = await mkdtemp(join(tmpdir(), 'dsh-live-model-ws-'));
      dirs.push(cwd);

      const adapter = new DshAdapter({
        binary,
        profileStateDir: dir,
        provider: DEFAULT_DSH_PROVIDER,
        sandbox: 'danger-full-access',
      });

      const runOptions = { runId: 'live-model', prompt: '只回复 OK。', cwd, model: 'GLM-5.2' };
      await adapter.prepareRun(runOptions);
      const events = await collect(adapter.run(runOptions).events);

      // The overlay is what makes the choice reach DSH at all.
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      expect(finalText(events).trim()).not.toBe('');
    },
    240_000,
  );
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function sessionOf(events: AgentEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'system' && event.sessionId) return event.sessionId;
  }
  return undefined;
}

function finalText(events: AgentEvent[]): string {
  const finals = events.filter((event) => event.type === 'final_text');
  if (finals.length) return finals.map((event) => event.content).join('');
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.delta)
    .join('');
}
