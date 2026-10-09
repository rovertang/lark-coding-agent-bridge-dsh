import { describe, expect, it } from 'vitest';
import { parseTaskRunning, withAccessDeniedHint } from '../../../src/daemon/schtasks';

describe('schtasks output parsing', () => {
  it('recognizes a running task in English and zh-CN listings', () => {
    // Field names stay English on a zh-CN Windows, but the state value is
    // localized — both spellings must count as running, otherwise
    // `bridge status` / `waitUntilStopped` misread a healthy daemon.
    expect(parseTaskRunning('Status:                               Running')).toBe(true);
    expect(parseTaskRunning('Status:                               正在运行')).toBe(true);
    expect(parseTaskRunning('状态:                                 正在运行')).toBe(true);
  });

  it('treats Ready / Disabled / missing output as not running', () => {
    expect(parseTaskRunning('Status:                               Ready')).toBe(false);
    expect(parseTaskRunning('Status:                               Disabled')).toBe(false);
    // 267009 = SCHED_S_TASK_RUNNING is the *Last Result* of a running task,
    // but a generic "Ready" listing must not be mistaken for one.
    expect(parseTaskRunning('Status:                               Ready\nLast Result:                          267009')).toBe(false);
    expect(parseTaskRunning('')).toBe(false);
  });

  it('falls back to the state code when the locale spells Status differently', () => {
    // Neither the field name nor the value matches the patterns above, so the
    // only signal left is the state code: 267009 (SCHED_S_TASK_RUNNING) is what
    // a running task reports as its Last Result, and numbers are not localized.
    expect(
      parseTaskRunning(
        "Statut:                          En cours d'exécution\nDernier résultat:                267009",
      ),
    ).toBe(true);
    // A task that never ran reports 267011 (SCHED_S_TASK_HAS_NOT_RUN), so the
    // fallback is not a blanket "any unrecognized output means running".
    expect(
      parseTaskRunning('Statut:                          Prêt\nDernier résultat:                267011'),
    ).toBe(false);
  });

  it('turns an access-denied /Create failure into an actionable message', () => {
    const denied = withAccessDeniedHint(
      { ok: false, stdout: '', stderr: 'ERROR: Access is denied.' },
      'LarkChannelBridge.Bot.dsh',
    );
    expect(denied.ok).toBe(false);
    expect(denied.stderr).toContain('Access is denied');
    // The raw error never explains that the task belongs to another account.
    expect(denied.stderr).toContain('schtasks /Delete /F /TN "LarkChannelBridge.Bot.dsh"');
  });

  it('leaves success and unrelated failures untouched', () => {
    const ok = { ok: true, stdout: 'SUCCESS', stderr: '' };
    expect(withAccessDeniedHint(ok, 'T')).toBe(ok);
    const other = { ok: false, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    expect(withAccessDeniedHint(other, 'T')).toBe(other);
  });
});
