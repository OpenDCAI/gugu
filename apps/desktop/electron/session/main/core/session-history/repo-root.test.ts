import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot, resetRepoRootCache } from './repo-root';

// spec session-page「会话历史」(#6083):本机原件按 git 仓库归节。这里在真磁盘上造出仓库 / worktree / 子模块 /
// 非仓库目录四种形状,钉住「哪一级是根」。

describe('findRepoRoot', () => {
  let base: string;

  beforeEach(() => {
    resetRepoRootCache();
    base = mkdtempSync(join(tmpdir(), 'repo-root-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('子目录归到仓库根', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(findRepoRoot(join(repo, 'src', 'deep'))).toBe(repo);
    expect(findRepoRoot(repo)).toBe(repo);
  });

  it('worktree(.git 是指向 <主仓>/.git/worktrees/<名字> 的文件)归到主仓', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git', 'worktrees', 'fix-1'), { recursive: true });
    const worktree = join(base, 'elsewhere', 'fix-1');
    mkdirSync(join(worktree, 'pkg'), { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'fix-1')}\n`);
    expect(findRepoRoot(join(worktree, 'pkg'))).toBe(repo);
  });

  it('子模块(gitdir 不是 worktrees/ 下)是它自己的根', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git', 'modules', 'lib'), { recursive: true });
    const sub = join(repo, 'lib');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/lib\n');
    expect(findRepoRoot(sub)).toBe(sub);
  });

  it('不在任何仓库里、或目录已经不在了:null', () => {
    const plain = join(base, 'plain', 'dir');
    mkdirSync(plain, { recursive: true });
    expect(findRepoRoot(plain)).toBeNull();
    expect(findRepoRoot(join(base, 'gone', 'away'))).toBeNull();
  });
});
