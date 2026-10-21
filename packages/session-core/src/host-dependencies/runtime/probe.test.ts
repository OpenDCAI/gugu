import { describe, expect, it } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { defaultProbeStatus, resolveAllCommandPaths, resolveCommandPath, resolveKnownPaths, VERSION_RE } from './probe';

/** Records what each lookup asked the host to run, and answers like `where`/`which` would. */
function recordingContext(stdout: string) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const ctx = {
    exec: async (command: string, args: string[] = []) => {
      calls.push({ command, args });
      return { stdout, stderr: '' };
    },
  } as unknown as IExecutionContext;
  return { ctx, calls };
}

describe('Windows `where` is asked in a shape it accepts', () => {
  it('turns an absolute path into dir:pattern, since `where C:\\dir\\file` is rejected outright', async () => {
    const { ctx, calls } = recordingContext('C:\\node\\claude.cmd\r\n');

    await expect(resolveCommandPath('C:\\node\\claude.cmd', ctx, 'windows')).resolves.toBe(
      'C:\\node\\claude.cmd'
    );
    await resolveAllCommandPaths('C:\\Program Files\\Git\\cmd\\git.exe', ctx, 'windows');
    await resolveCommandPath('C:/Users/me/.local/bin/claude.exe', ctx, 'windows');
    await resolveCommandPath('C:\\claude.exe', ctx, 'windows');

    expect(calls).toEqual([
      { command: 'where', args: ['C:\\node:claude.cmd'] },
      { command: 'where', args: ['C:\\Program Files\\Git\\cmd:git.exe'] },
      { command: 'where', args: ['C:/Users/me/.local/bin:claude.exe'] },
      // A file at the drive root keeps the root separator; `where C:\:file` is accepted.
      { command: 'where', args: ['C:\\:claude.exe'] },
    ]);
  });

  it('leaves a bare command name and POSIX lookups untouched', async () => {
    const { ctx, calls } = recordingContext('/usr/local/bin/claude\n');

    await resolveCommandPath('claude', ctx, 'windows');
    await resolveCommandPath('/usr/local/bin/claude', ctx, 'macos');

    expect(calls).toEqual([
      { command: 'where', args: ['claude'] },
      { command: 'which', args: ['/usr/local/bin/claude'] },
    ]);
  });
});

/** A host where only `existing` files are found and `~`/`%VAR%` expand to the given values. */
function hostWith(existing: string[], expand: { home?: string; vars?: Record<string, string> }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const ctx = {
    exec: async (command: string, args: string[] = []) => {
      calls.push({ command, args });
      if (command === 'sh') {
        if (!expand.home) throw new Error('no HOME');
        return { stdout: expand.home, stderr: '' };
      }
      if (command === 'cmd') {
        const echoed = args[args.length - 1]!.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => expand.vars?.[name] ?? m);
        return { stdout: `${echoed}\r\n`, stderr: '' };
      }
      // which / where: found only when the (re-joined) path is in `existing`.
      const asked = command === 'where' ? args[0]!.replace(/:(?=[^:\\/]*$)/, '\\') : args[0]!;
      if (existing.includes(asked)) return { stdout: `${asked}\n`, stderr: '' };
      throw new Error('not found');
    },
  } as unknown as IExecutionContext;
  return { ctx, calls };
}

describe('resolveKnownPaths: vendor install locations off PATH', () => {
  it('returns only the declared locations that exist, in declared order', async () => {
    const { ctx } = hostWith(['/opt/ZCode/resources/glm/zcode.cjs'], {});
    await expect(
      resolveKnownPaths(['/opt/Missing/zcode.cjs', '/opt/ZCode/resources/glm/zcode.cjs'], ctx, 'linux')
    ).resolves.toEqual(['/opt/ZCode/resources/glm/zcode.cjs']);
  });

  it('expands a leading ~/ with the target host\'s HOME', async () => {
    const { ctx, calls } = hostWith(['/Users/me/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'], { home: '/Users/me' });
    await expect(
      resolveKnownPaths(['~/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'], ctx, 'macos')
    ).resolves.toEqual(['/Users/me/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs']);
    expect(calls[0]).toEqual({ command: 'sh', args: ['-c', 'printf %s "$HOME"'] });
  });

  it('expands %VAR% through the target host\'s cmd on Windows', async () => {
    const found = 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
    const { ctx, calls } = hostWith([found], { vars: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } });
    await expect(
      resolveKnownPaths(['%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs'], ctx, 'windows')
    ).resolves.toEqual([found]);
    expect(calls[0]?.command).toBe('cmd');
  });

  it('skips a location whose variable does not expand, instead of probing the literal', async () => {
    const { ctx, calls } = hostWith([], { vars: {} });
    await expect(resolveKnownPaths(['%NOPE%\\zcode.cjs'], ctx, 'windows')).resolves.toEqual([]);
    expect(calls.map((c) => c.command)).toEqual(['cmd']);
  });
});

/**
 * 版本号的那把尺。2026-09-22 真机撞到:GitHub Copilot 的 `--version` 打印 `1.0.87.`,
 * 面板照着写出「已安装 v1.0.87.」—— 句末那个点被 `[\d.]*` 一起吃了进去。
 */
describe('VERSION_RE', () => {
  it('句末的点不算版本号的一部分', () => {
    expect(VERSION_RE.exec('GitHub Copilot CLI 1.0.87.')?.[1]).toBe('1.0.87');
  });

  it('正常的版本串一个字符都不少', () => {
    // 阳控:上一条的绿不能是因为这把尺把什么都截短了。
    expect(VERSION_RE.exec('claude 2.1.266 (Claude Code)')?.[1]).toBe('2.1.266');
    expect(VERSION_RE.exec('1.0')?.[1]).toBe('1.0');
    expect(VERSION_RE.exec('codex-cli 0.2.44-rc.1')?.[1]).toBe('0.2.44');
    expect(VERSION_RE.exec('tool 1.2.3.4')?.[1]).toBe('1.2.3.4');
  });

  it('「它报出版本了吗」这一路不受影响 —— 带句点的串照样算报出了版本', () => {
    // 这把尺同时被 `defaultProbeStatus` 用来判「跑挂了但仍报出版本」。收紧捕获组不能把
    // 那一路的答案改掉,否则 copilot 这类非零退出的 CLI 会从「可用」翻成「起不来」。
    expect(
      defaultProbeStatus({
        command: 'copilot --version',
        path: null,
        stdout: '1.0.87.',
        stderr: '',
        exitCode: 1,
        timedOut: false,
      }),
    ).toBe('available');
  });
});
