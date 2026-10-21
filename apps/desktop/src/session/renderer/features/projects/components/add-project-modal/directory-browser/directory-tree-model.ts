// 目录树的纯逻辑(不碰 React / rpc):哪些条目算子目录、节点叫什么名。
import type { DirectoryEntry } from '@shared/core/fs/fs';
import { normalizePath } from './paths';

const byName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: 'base' });

/**
 * 树只列目录:符号链接可能指向文件也可能成环,选项目根时不当子目录看。
 * 点开头的隐藏目录排在可见目录之后:家目录下几十个 .cache/.config 会把真正的项目夹挤出首屏,
 * 但不藏——worktree 之类就住在 .claude/ 下面。
 */
export function subdirectoryPaths(entries: readonly DirectoryEntry[]): string[] {
  const paths = entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => normalizePath(entry.path));
  const hidden = (path: string) => path.slice(path.lastIndexOf('/') + 1).startsWith('.');
  return [
    ...paths.filter((path) => !hidden(path)).sort(byName),
    ...paths.filter(hidden).sort(byName),
  ];
}

/** 根节点显示完整路径(用户要知道树长在哪台机器的哪),其余显示最后一段。 */
export function directoryNodeName(path: string, rootPath: string): string {
  const normalized = normalizePath(path);
  if (normalized === normalizePath(rootPath)) return normalized;
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}
