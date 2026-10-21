import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createBoundExec } from '@gugu/session-core/exec';
import { NON_INTERACTIVE_GIT_ENV } from '@main/core/execution-context/non-interactive-git-env';
import { getGitExecutable } from '@main/core/utils/exec';

const BRANCH_READ_TIMEOUT_MS = 3_000;

/**
 * 文件夹此刻检出的分支(#7341 项目首页的文件夹卡上那一行)。只问本地 HEAD:❌ 联网、❌ 开 worktree 租约(会起 watcher)。
 *
 * 文件夹自己没有 `.git`(不是仓库根,或根本不是仓库)⇒ null —— 与会话在这个文件夹开工时判「非 git」同一口径
 * (见 workspace-git-context.ts:挂上的文件夹照它自己的目录判)。分离 HEAD、git 读失败也是 null:分支只是卡片上的
 * 一行字,读不到不该让整张卡出不来。
 */
export async function readFolderBranch(folderPath: string): Promise<string | null> {
  try {
    await stat(path.join(folderPath, '.git'));
  } catch {
    return null;
  }
  try {
    const git = createBoundExec({
      file: getGitExecutable(),
      cwd: folderPath,
      env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
    });
    const { stdout } = await git.exec(['symbolic-ref', '--short', '-q', 'HEAD'], {
      timeoutMs: BRANCH_READ_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
