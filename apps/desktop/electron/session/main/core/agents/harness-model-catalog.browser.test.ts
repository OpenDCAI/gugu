import { describe, expect, it } from 'vitest';
import { suppressBrowserLaunch } from './harness-model-catalog';

describe('suppressBrowserLaunch (background model probe must not pop a login page)', () => {
  it('points BROWSER at a no-op that exits 0 on posix', () => {
    expect(suppressBrowserLaunch({ A: '1' }, 'darwin')).toEqual({ A: '1', BROWSER: 'true' });
    expect(suppressBrowserLaunch({}, 'linux').BROWSER).toBe('true');
  });

  // #6335:Python webbrowser 在非 0 时会落到 windows-default 弹浏览器;.cmd 会让 URL 的 & 被 cmd 执行。
  it('points BROWSER at attrib.exe under SystemRoot on Windows — a real .exe, never a .cmd', () => {
    expect(suppressBrowserLaunch({ SystemRoot: 'D:\\Win' }, 'win32').BROWSER).toBe('D:\\Win\\System32\\attrib.exe');
    expect(suppressBrowserLaunch({ SYSTEMROOT: 'C:\\Windows' }, 'win32').BROWSER).toBe('C:\\Windows\\System32\\attrib.exe');
  });
});
