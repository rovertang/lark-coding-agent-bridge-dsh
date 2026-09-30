import { describe, expect, it } from 'vitest';
import { buildDshArgs, toDshPermissionMode } from '../../../src/agent/dsh/argv.js';

describe('Dsh argv contract', () => {
  it('builds a headless json run that reads the task from stdin', () => {
    expect(buildDshArgs({ profile: 'headless' })).toEqual([
      '--profile',
      'headless',
      '--json',
      '-',
    ]);
  });

  it('puts each patch overlay before --json, in order', () => {
    expect(
      buildDshArgs({
        profile: 'headless',
        patches: ['/state/dsh/provider.patch.yml', '/state/dsh/model-abc.patch.yml'],
      }),
    ).toEqual([
      '--profile',
      'headless',
      '--patch',
      '/state/dsh/provider.patch.yml',
      '--patch',
      '/state/dsh/model-abc.patch.yml',
      '--json',
      '-',
    ]);
  });

  it('continues a session with --session-id and still reads the task from stdin', () => {
    const args = buildDshArgs({ profile: 'headless', sessionId: 'session-123' });
    expect(args).toEqual([
      '--profile',
      'headless',
      '--json',
      '--session-id',
      'session-123',
      '-',
    ]);
    expect(args.at(-1)).toBe('-');
  });

  it('never puts the prompt in argv', () => {
    expect(buildDshArgs({ profile: 'headless', sessionId: 'session-123' }).join(' ')).not.toContain(
      'hello',
    );
  });

  it('omits --patch entirely when no overlays are configured', () => {
    expect(buildDshArgs({ profile: 'headless', patches: [] })).not.toContain('--patch');
  });

  it('passes the bridge sandbox vocabulary through unchanged', () => {
    expect(toDshPermissionMode('read-only')).toBe('read-only');
    expect(toDshPermissionMode('workspace-write')).toBe('workspace-write');
    expect(toDshPermissionMode('danger-full-access')).toBe('danger-full-access');
  });

  it('rejects an unknown sandbox mode instead of widening access', () => {
    expect(() => toDshPermissionMode('yolo' as never)).toThrow(/unsafe sandbox mode/);
  });
});
