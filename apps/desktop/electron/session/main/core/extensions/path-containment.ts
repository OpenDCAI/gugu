import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a relative path stays inside a root, symlinks included.
 *
 * One implementation, because two copies of a containment check drift and the
 * copy that drifts is the one that stops refusing. Its callers — a task's files
 * (`local-files`, `sessionFileOf`) and the icon reader — take the same supplied strings and
 * need the same answer; they differ only in how they report a refusal, which is
 * why this returns a boolean instead of throwing. Refs #2374.
 */
export function resolvesInside(root: string, relative: string): string | null {
  if (typeof relative !== 'string' || relative.length === 0) return null;
  if (path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  // Resolve whatever exists of the chain: a symlink at any level would otherwise
  // pass the string test above and still land outside.
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  // ⚠️ 两边都要 realpath 再比。macOS 上 `/var/...` 的真身是 `/private/var/...`,
  // 只解目标那一半会让**每一次调用都判成越界** —— 在 macOS 上这意味着扩展图标
  // 一个都渲染不出来、工作副本一个字节也写不进去,而 Linux 上全绿。这条是在
  // mac1 上真跑单测才露出来的,不是想出来的。
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const real = fs.realpathSync(existing);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return target;
}
