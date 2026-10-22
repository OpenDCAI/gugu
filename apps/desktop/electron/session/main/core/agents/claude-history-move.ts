import { constants } from 'node:fs';
import { cp, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 单一目录之前(#26),Claude 账号 / API 连接上的会话跑在连接自己的配置根里,记录也写在那里。
 * 现在会话都跑在用户根上;要在那里接着 `--resume` 原来的对话,记录得在用户根里:按文件复制过去,
 * 用户根里已有的同名文件一律不碰(❌ 覆盖)。APFS 上是克隆,不占双份空间。
 *
 * 每个连接只做一次,做完在连接根里留个记号:之后连接根只剩保管凭据,不会再长出会话记录。
 */
const SESSION_STATE_DIRS = ['projects', 'file-history', 'todos'] as const;
const MARKER = '.gugu-history-moved';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 返回这次有没有搬(已经搬过、或连接根不在 ⇒ false)。 */
export async function moveClaudeHistoryToUserRoot(connectionRoot: string, nativeRoot: string): Promise<boolean> {
  if (!(await exists(connectionRoot)) || (await exists(join(connectionRoot, MARKER)))) return false;
  for (const name of SESSION_STATE_DIRS) {
    const source = join(connectionRoot, name);
    if (!(await exists(source))) continue;
    await cp(source, join(nativeRoot, name), {
      recursive: true,
      force: false,
      errorOnExist: false,
      preserveTimestamps: true,
      mode: constants.COPYFILE_FICLONE,
      // 用户根里的 `projects`(或其下某个项目)可能是指向别处的符号链接:不跟过去,cp 会把它当「不是目录」直接报错。
      dereference: true,
    });
  }
  await writeFile(join(connectionRoot, MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return true;
}
