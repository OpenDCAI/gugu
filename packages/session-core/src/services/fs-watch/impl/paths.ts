import { realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export function realpathOrResolve(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    try {
      return realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }
}

/**
 * ignore glob 一律按「相对监听根」解释 —— 现有调用方给的就是这个形态
 * （`.git/**`、`node_modules/**`、`objects/**`）。❌ 再拿绝对路径去比:忽略表里的 tmp 会命中根本身所在的
 * `/private/tmp/…`、.worktrees 会命中 `<repo>/.worktrees/x`,整个工作区的事件全被丢掉。
 */
export function buildIgnoreFilter(root: string, ignore: string[] | undefined): (target: string) => boolean {
  if (!ignore || ignore.length === 0) return () => false;
  const isMatch = picomatch(ignore, { dot: true });
  return (target: string) => {
    const relative = path.relative(root, target);
    // 落在根之外的路径不该出现；真出现了就当作要忽略,而不是硬塞给消费者。
    if (relative.startsWith('..')) return true;
    return isMatch(relative);
  };
}
