import { NON_INTERACTIVE_GIT_ENV } from '@main/core/execution-context/non-interactive-git-env';
import { buildUserShellBaseEnv } from '@main/utils/childProcessEnv';

/**
 * #6264 审阅页(本机与别的机器上)的 git 用**与 agent 同一份**登录环境:用户只在 `~/.bashrc` / `~/.zshrc` 里
 * export 的 `GH_TOKEN`、`GIT_SSH_COMMAND`、`SSH_AUTH_SOCK` 这类,agent 的 `git push` 拿得到、审阅页「提交并推送」
 * 却拿不到 —— 同一台机器上两个按钮两种结果。照 VS Code:内置 Git 跑在已解析的 shell 环境里
 * (https://code.visualstudio.com/docs/terminal/advanced「Extension environment contributions」)。
 *
 * 分层与 agent 的 `buildAgentEnv` 同一个底座(`buildUserShellBaseEnv`:登录 shell 快照 + 本进程环境,过同一张负名单),
 * 本进程环境整份压在上面(= 改之前的全部行为不变,只是多了登录 shell 里才有的那些),再叠非交互开关与 `LC_ALL=C`
 * (错误分类按英文原文匹配;给人看的话由上层翻)。纯函数,单测钉住。
 */
export function reviewGitEnv(input: {
  processEnv: NodeJS.ProcessEnv;
  loginShellEnv: Record<string, string> | null;
  sshAuthSock?: () => string | null | undefined;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildUserShellBaseEnv({ loginShellEnv: input.loginShellEnv, processEnv: input.processEnv }),
    ...input.processEnv,
  };
  if (!env.SSH_AUTH_SOCK) {
    const sock = input.sshAuthSock?.() ?? null;
    if (sock) env.SSH_AUTH_SOCK = sock;
  }
  return { ...env, ...NON_INTERACTIVE_GIT_ENV, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
}
