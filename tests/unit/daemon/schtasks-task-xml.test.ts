import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHiddenWrapperVbs,
  buildTaskXml,
  encodeHiddenWrapperVbs,
} from '../../../src/daemon/schtasks';

describe('Windows Task Scheduler (schtasks) definition', () => {
  const wrapper = String.raw`C:\Users\u\.lark-channel\daemon\dsh\launcher-hidden.vbs`;

  it('hides the launcher window, waits for it, and propagates failure', () => {
    const vbs = buildHiddenWrapperVbs(String.raw`C:\Users\u\.lark-channel\daemon\dsh\launcher.cmd`);
    // Window style 0 = hidden; bWaitOnReturn = True keeps the task instance
    // alive while the daemon runs.
    expect(vbs).toContain(String.raw`code = sh.Run("""C:\Users\u\.lark-channel\daemon\dsh\launcher.cmd""", 0, True)`);
    // A launcher that cannot even be started must surface as a failed action,
    // not as a quiet success that nothing ever retries.
    expect(vbs).toContain('On Error Resume Next');
    expect(vbs).toContain('If Err.Number <> 0 Then WScript.Quit 1');
    // The daemon's own exit code is propagated (non-zero = failed action, which
    // is what RestartOnFailure acts on).
    expect(vbs).toContain('WScript.Quit code');
    expect(vbs).not.toContain('WScript.Quit 0');
  });

  it('writes the wrapper as UTF-16LE with a BOM', () => {
    // Windows Script Host decodes a UTF-8 script with the ANSI code page, which
    // turns any non-ASCII path inside it into mojibake and leaves the daemon
    // never started. UTF-16LE + BOM is the form WSH decodes as Unicode.
    const vbs = buildHiddenWrapperVbs(String.raw`C:\Users\中文用户\.lark-channel\daemon\dsh\launcher.cmd`);
    const bytes = encodeHiddenWrapperVbs(vbs);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(vbs);
    // The non-ASCII path survives the round trip byte-for-byte.
    expect(bytes.subarray(2).toString('utf16le')).toContain('中文用户');
    expect(bytes.toString('utf8')).not.toBe(vbs);
  });

  it('keeps a laptop daemon alive: battery, time limit, restart, no console', () => {
    const xml = buildTaskXml({ taskName: 'LarkChannelBridge.Bot.dsh', wrapperPath: wrapper, userId: 'PC\\u' });

    // Unplugging the charger must not kill the daemon, and autostart must
    // still work while on battery.
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    // The 72h default would hard-terminate a forever-daemon.
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    // An unexpected exit retries instead of waiting for the next logon.
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    // No console window: the task action is the hidden wscript wrapper.
    expect(xml).toContain('<Command>wscript.exe</Command>');
    expect(xml).toContain(`//nologo "${wrapper}"`);
    // Same user/privilege semantics as before: lowest privileges, at logon.
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\u</UserId>');
  });

  it('escapes XML-significant characters in user and wrapper paths', () => {
    const xml = buildTaskXml({ taskName: 't', wrapperPath: 'C:\\a & b\\<x>.vbs', userId: 'd\\u&v' });
    expect(xml).toContain('C:\\a &amp; b\\&lt;x&gt;.vbs');
    expect(xml).toContain('d\\u&amp;v');
    expect(xml).not.toContain('& b');
  });
});

// The wrapper is only useful if Windows Script Host can actually run it, which
// depends on the file's encoding — not something the string-level assertions
// above can prove. Runs the real generated artifact through cscript.
describe.skipIf(process.platform !== 'win32')('hidden wrapper, executed by Windows Script Host', () => {
  it('starts a launcher that lives under a non-ASCII path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-vbs-'));
    try {
      // Non-ASCII only in the path: that is the part WSH has to decode from the
      // wrapper, and the part a UTF-8 wrapper would mangle into mojibake.
      const dir = join(root, '中文-用户');
      await mkdir(dir, { recursive: true });
      const marker = join(root, 'marker.txt');
      const cmdPath = join(dir, 'launcher.cmd');
      await writeFile(cmdPath, `@echo off\r\necho launched > "${marker}"\r\n`, 'ascii');

      const vbsPath = join(dir, 'launcher-hidden.vbs');
      await writeFile(vbsPath, encodeHiddenWrapperVbs(buildHiddenWrapperVbs(cmdPath)));

      const r = spawnSync('cscript', ['//nologo', vbsPath], { stdio: 'ignore' });

      await expect(readFile(marker, 'utf8')).resolves.toContain('launched');
      expect(r.status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
