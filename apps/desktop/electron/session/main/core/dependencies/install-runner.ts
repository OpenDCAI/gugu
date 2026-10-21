import type { InstallCommandContext, InstallCommandError } from '@gugu/session-core/deps/runtime';
import { err, type Result } from '@gugu/session-shared';
import { ensureUserBinDirsInPath } from '@main/utils/userEnv';
import { runMiseOperation } from './mise-installer';

export type InstallCommandRunner<TData = void, TError = InstallCommandError> = (
  command: string,
  context?: InstallCommandContext,
) => Promise<Result<TData, TError>>;

/**
 * 产品内的安装只有一条执行路径:内置 mise(#6098,owner 2026-09-21)。
 *
 * ❌ 这里曾经还有一条 shell 直装腿(在 PTY 里跑 `npm install -g …` / 厂商的 curl 脚本 /
 * brew / winget),npm 的 ENOTEMPTY 重试、10 分钟静默判卡、盲文进度条清洗都长在它身上。
 * 删掉它删掉的不只是代码:一条装法一个落点,而「装到哪儿了」正是安装事实靠推断、
 * 探测失败折成未安装、Windows 上 `.cmd` 壳被裸 spawn 这三类票的共同根。
 * 装不了的家现在在 descriptor 上就写着装不了,界面请用户自己装完选那一份。
 */
export function createLocalInstallCommandRunner(): InstallCommandRunner {
  return async (_command, context) => {
    if (!context?.mise) {
      return err({
        type: 'unsupported-host',
        message: 'Gugu only installs agents through its bundled installer.',
      });
    }
    const result = await runMiseOperation(context);
    ensureUserBinDirsInPath();
    return result;
  };
}
