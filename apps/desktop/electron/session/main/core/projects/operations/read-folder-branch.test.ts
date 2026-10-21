// #7341 文件夹卡上的分支:用真 git 读真目录。读不到一律 null,不抛 —— 但读得到时必须是那个分支的名字。
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFolderBranch } from './read-folder-branch';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('readFolderBranch', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'gugu-folder-branch-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('仓库根:读出当前检出的分支(还没有提交也算)', async () => {
    const repo = path.join(tmp, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feat/7341-project-folders');

    expect(await readFolderBranch(repo)).toBe('feat/7341-project-folders');
  });

  it('不是仓库、仓库里的子目录(自己没有 .git)、不存在的目录 ⇒ null', async () => {
    const plain = path.join(tmp, 'plain');
    const repo = path.join(tmp, 'repo');
    await mkdir(plain);
    await mkdir(path.join(repo, 'sub'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');

    expect(await readFolderBranch(plain)).toBeNull();
    expect(await readFolderBranch(path.join(repo, 'sub'))).toBeNull();
    expect(await readFolderBranch(path.join(tmp, 'missing'))).toBeNull();
    // 阳控:同一个仓库的根读得出来 —— 上面那条 null 不是因为这台机器上 git 根本跑不起来
    expect(await readFolderBranch(repo)).toBe('main');
  });

  it('分离 HEAD ⇒ null(那里没有分支)', async () => {
    const repo = path.join(tmp, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    git(
      repo,
      '-c', 'user.email=t@example.com',
      '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '--allow-empty', '-m', 'init'
    );
    git(repo, 'checkout', '-q', '--detach');

    expect(await readFolderBranch(repo)).toBeNull();
  });
});
