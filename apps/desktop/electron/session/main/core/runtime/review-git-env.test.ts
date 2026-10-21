import { describe, expect, it } from 'vitest';
import { reviewGitEnv } from './review-git-env';

describe('#6264 审阅页的 git 与 agent 同一份登录环境', () => {
  it('只 export 在 .bashrc 里的 GH_TOKEN / GIT_SSH_COMMAND 也到得了审阅页的 git', () => {
    const env = reviewGitEnv({
      processEnv: { PATH: '/usr/bin', HOME: '/home/a' },
      loginShellEnv: { GH_TOKEN: 'ghp_x', GIT_SSH_COMMAND: 'ssh -i ~/.ssh/k', PATH: '/login/bin' },
    });
    expect(env.GH_TOKEN).toBe('ghp_x');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/k');
    // 本进程已并好的 PATH 压过快照(与改之前一样)
    expect(env.PATH).toBe('/usr/bin');
  });

  it('仍然非交互、按英文原文出错(错误分类靠它)', () => {
    const env = reviewGitEnv({ processEnv: { LANG: 'zh_CN.UTF-8' }, loginShellEnv: null });
    expect(env).toMatchObject({ LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' });
  });

  it('SSH_AUTH_SOCK:本进程没有、快照也没有时才去找', () => {
    expect(reviewGitEnv({ processEnv: {}, loginShellEnv: null, sshAuthSock: () => '/tmp/agent.1' }).SSH_AUTH_SOCK).toBe('/tmp/agent.1');
    expect(
      reviewGitEnv({ processEnv: {}, loginShellEnv: { SSH_AUTH_SOCK: '/run/a' }, sshAuthSock: () => '/tmp/agent.1' }).SSH_AUTH_SOCK
    ).toBe('/run/a');
  });
});
