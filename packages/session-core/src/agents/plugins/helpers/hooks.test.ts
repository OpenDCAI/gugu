import { describe, expect, it } from 'vitest';
import {
  GUGU_HOOK_MARKER,
  isGuguHookText,
  makeNotificationHookCommand,
  makeStdinHookCommand,
  makeWindowsPowerShellHookCommand,
} from './hooks';

const win32 = { platform: 'win32' as const };
const PREFIX = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "';

describe('Windows hook command: one line cmd.exe, PowerShell and Git Bash all run unchanged', () => {
  it.each([
    ['stdin event', makeStdinHookCommand('stop', win32)],
    ['fixed notification body', makeNotificationHookCommand('idle_prompt', win32)],
  ])('%s: a single powershell.exe call, script quoted with nothing a shell would rewrite', (_, command) => {
    expect(command.startsWith(PREFIX)).toBe(true);
    expect(command.endsWith('"')).toBe(true);
    const script = command.slice(PREFIX.length, -1);
    expect(script).not.toMatch(/["$`%!\\\r\n]/);
    expect(command).not.toContain('&&');
    expect(isGuguHookText(command)).toBe(true);
  });

  it('refuses a script some hook shell would rewrite, or one gugu could not recognise as its own', () => {
    expect(() => makeWindowsPowerShellHookCommand(`if (-not $env:${GUGU_HOOK_MARKER}) { exit 0 }`)).toThrow(
      /"\$"/
    );
    expect(() => makeWindowsPowerShellHookCommand('exit 0')).toThrow(GUGU_HOOK_MARKER);
  });
});
