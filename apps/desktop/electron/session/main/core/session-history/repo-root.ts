import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

// spec session-page「会话历史」(#6083):本机原件按 git 仓库归节 —— 同一个仓库的子目录、worktree 并成一节
// (主人 2026-09-24 同意的改法:mac1 上 6500 条原件按 cwd 分出 1345 节,大多一两条,人找不到东西)。
//
// 判法只看磁盘:从目录往上找 `.git`。是目录 ⇒ 这里就是仓库根;是文件(`gitdir: …`)且指向
// `<主仓>/.git/worktrees/<名字>` ⇒ 这是主仓的一个 worktree,根 = 主仓;其它 gitdir(子模块)⇒ 自己是根。
// 目录已被删掉(用完即弃的 /tmp、codex worktree)读不到 ⇒ null,调用方按目录本身归节。
// home 目录本身是仓库(dotfiles)时不算:它会把 home 下所有不在别的仓库里的会话吞成一节,
// 正是 /Users 那种「太宽的项目」。

const CACHE_TTL_MS = 60_000;

let cache = new Map<string, string | null>();
let cacheBornAt = 0;

function gitEntryKind(dir: string): 'dir' | 'file' | null {
  try {
    const stat = statSync(resolve(dir, '.git'));
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
  } catch {
    // ENOENT / EACCES / 目录已删:这一级没有 .git,继续往上。
    return null;
  }
}

function rootOfGitFile(dir: string): string {
  let text: string;
  try {
    text = readFileSync(resolve(dir, '.git'), 'utf8');
  } catch {
    return dir;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return dir;
  const gitdir = isAbsolute(match[1]) ? match[1] : resolve(dir, match[1]);
  const worktree = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
  return worktree ? worktree[1] : dir;
}

/** `directory` 所在 git 仓库的根(worktree 归到主仓);不在任何仓库里、或目录读不到时为 null。 */
export function findRepoRoot(directory: string, now: number = Date.now()): string | null {
  if (now - cacheBornAt > CACHE_TTL_MS) {
    cache = new Map();
    cacheBornAt = now;
  }
  const home = homedir();
  const visited: string[] = [];
  let current = resolve(directory);
  let root: string | null = null;
  for (;;) {
    const cached = cache.get(current);
    if (cached !== undefined) {
      root = cached;
      break;
    }
    visited.push(current);
    const kind = current === home ? null : gitEntryKind(current);
    if (kind === 'dir') {
      root = current;
      break;
    }
    if (kind === 'file') {
      root = rootOfGitFile(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 从起点到找到根之间的每一级都没有自己的 .git ⇒ 它们的答案与起点相同。
  for (const dir of visited) cache.set(dir, root);
  return root;
}

/** 测试用:清掉缓存(测试会在同一路径上前后造出不同的仓库形状)。 */
export function resetRepoRootCache(): void {
  cache = new Map();
  cacheBornAt = 0;
}
