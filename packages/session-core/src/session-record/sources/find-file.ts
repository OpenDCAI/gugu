import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 记录源找文件用的两件 node 端小件。单独成文件：`shared.ts` 会被 barrel 再导出给渲染层，❌ 在那里碰 node:fs。
 */

/** 是个文件吗。不在、读不到都算不是 —— 找记录时「这个候选没有」不是错。 */
export async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ?? false;
}

/**
 * 按根的顺序，在每个根下**一层**子目录里找记录文件:`<根>/<任一子目录>/<sub>/<文件>`。
 * 子目录名是各家对工作目录的改写(规则随版本变),宿主不重算，按会话 id 找就是唯一的。
 * `match` 是文件名就直接 stat;是判定函数(文件名里只带着 id)就列目录挑。
 */
export async function findUnder(
  roots: string[],
  sub: string,
  match: string | ((name: string) => boolean)
): Promise<string | null> {
  for (const root of roots) {
    let dirs;
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // 这个根不在(这一家 / 这条腿没跑过)
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const at = join(root, dir.name, sub);
      if (typeof match === 'string') {
        if (await isFile(join(at, match))) return join(at, match);
        continue;
      }
      const names = await readdir(at).catch(() => [] as string[]);
      const hit = names.find(match);
      if (hit) return join(at, hit);
    }
  }
  return null;
}
