/**
 * #6264 一套工作台:问「这台机器」本身的那两件事(不属于哪个项目 / 会话)。别的电脑经 `rpcOn(机器)` 问。
 *  · 此刻有程序在听的端口(「端口」页签,人打开 / 刷新时读一次);
 *  · 这台机器上的 git 不知道署谁的名字时,就地填一次写进它的全局配置(审阅页提交时 `identity_unknown`)。
 */
import { err, ok } from '@gugu/session-shared';
import { isValidGitIdentity, type SessionpageGitIdentity } from '@gugu/session-core/session-record/contract';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { listListeningPorts, productionListeningPortsDeps } from './listening-ports';

async function setGlobalGitIdentity(identity: SessionpageGitIdentity): Promise<void> {
  const [{ execFile }, { promisify }, os, { reviewGitEnv }, { getGitExecutable }, { loginShellEnv }, { detectSshAuthSock }] =
    await Promise.all([
      import('node:child_process'),
      import('node:util'),
      import('node:os'),
      import('@main/core/runtime/review-git-env'),
      import('@main/core/utils/exec'),
      import('@main/utils/userEnv'),
      import('@main/utils/shellEnv'),
    ]);
  const run = promisify(execFile);
  const options = {
    cwd: os.homedir(),
    env: reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv(), sshAuthSock: detectSshAuthSock }),
    timeout: 15_000,
  };
  // 参数逐个传(不经 shell):名字里有引号、空格、中文都原样写进去。
  await run(getGitExecutable(), ['config', '--global', 'user.name', identity.name.trim()], options);
  await run(getGitExecutable(), ['config', '--global', 'user.email', identity.email.trim()], options);
}

export const machineController = createRPCController({
  listeningPorts: async () => {
    try {
      return ok(listListeningPorts(productionListeningPortsDeps()));
    } catch (error) {
      return err({ type: 'ports_failed' as const, message: (error as Error)?.message ?? String(error) });
    }
  },
  setGitIdentity: async (identity: SessionpageGitIdentity) => {
    if (!isValidGitIdentity(identity)) return err({ type: 'invalid_identity' as const, message: 'name and email are required' });
    try {
      await setGlobalGitIdentity(identity);
      return ok({ done: true as const });
    } catch (error) {
      return err({ type: 'git_failed' as const, message: (error as Error)?.message ?? String(error) });
    }
  },
});
