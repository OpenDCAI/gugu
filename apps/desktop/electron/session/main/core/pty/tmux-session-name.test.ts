import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { buildTmuxShellLine, tmuxTakeClientEnvironment } from './tmux-session-name';

function tmuxBinary(): string | null {
  const found = spawnSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

describe('tmux 新建会话拿这次 spawn 的环境(#6264)', () => {
  it('只在咕咕自己的服务器(有 socketLabel)上改 update-environment,值不进命令行', () => {
    const own = buildTmuxShellLine('s', 'claude', { binary: '/x/tmux', socketLabel: 'gugu-server-abc' });
    expect(own).toContain('update-environment');
    const user = buildTmuxShellLine('s', 'claude', { binary: '/x/tmux' });
    expect(user).not.toContain('update-environment');
    // 取名字的那一段只读变量名(sed 截到 = 为止),不列 tmux 自己的变量。
    expect(tmuxTakeClientEnvironment('tmux')).toContain("grep -Ev '^(TMUX|TMUX_PANE|TERM|");
  });

  it('咕咕自己的会话关掉 tmux 状态栏(它只是底座,❌ 露面叠在 harness 界面底下)', () => {
    expect(buildTmuxShellLine('s', 'claude', { binary: '/x/tmux', socketLabel: 'gugu-server-abc' })).toMatch(
      /set-option -t \S*s\S* status off/
    );
  });

  const tmux = tmuxBinary();
  const dir = mkdtempSync(path.join(tmpdir(), 'tmux-env-'));
  const label = `gugu-test-${process.pid}`;
  afterAll(() => {
    if (tmux) spawnSync(tmux, ['-L', label, 'kill-server']);
    rmSync(dir, { recursive: true, force: true });
  });

  // 真跑一遍:同一个服务器里先后开两条会话,第二条的进程拿到的必须是第二次 spawn 的环境。
  it.skipIf(!tmux)('the second session in a running server gets its own spawn env, not the first one', () => {
    const run = (session: string, value: string) => {
      const out = path.join(dir, `${session}.env`);
      const line = buildTmuxShellLine(session, `env > ${out}; sleep 30`, { binary: tmux!, socketLabel: label });
      // 与 pty 一样经 /bin/sh 起;attach 需要终端,这里只要「建会话」那一段,用 -c 跑到 attach 之前即可。
      const script = line.replace(/^\/bin\/sh -c /, '');
      const inner = execFileSync('/bin/sh', ['-c', `printf %s ${script}`], { encoding: 'utf8' });
      const createOnly = inner.slice(0, inner.lastIndexOf(' && '));
      execFileSync('/bin/sh', ['-c', createOnly], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', GUGU_PTY_ID: value, BROWSER: `${value}-browser` },
      });
      for (let i = 0; i < 50 && !existsSync(out); i++) execFileSync('/bin/sleep', ['0.1']);
      return readFileSync(out, 'utf8');
    };
    expect(run('one', 'first')).toContain('GUGU_PTY_ID=first');
    const second = run('two', 'second');
    expect(second).toContain('GUGU_PTY_ID=second');
    expect(second).toContain('BROWSER=second-browser');
  });
});
