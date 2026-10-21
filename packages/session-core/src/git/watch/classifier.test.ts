import { describe, expect, it } from 'vitest';
import { classifyGitWatchEvents } from './classifier';

const layout = {
  gitCommonDir: '/repo/.git',
  worktrees: [
    { id: 'main', gitDir: '/repo/.git', worktree: '/repo' },
    { id: 'feat', gitDir: '/repo/.git/worktrees/feat', worktree: '/repo/.worktrees/feat' },
  ],
};

describe('classifyGitWatchEvents', () => {
  // commit 重写 index、HEAD(符号引用)不变:只算 status 的话,commit 之后分支上的最新提交不刷新。
  it('an index write refreshes both status and head of that worktree', () => {
    const linked = classifyGitWatchEvents([{ kind: 'update', path: '/repo/.git/worktrees/feat/index' }], layout);
    expect(linked.worktrees.get('feat')).toMatchObject({ status: true, head: true });
    const main = classifyGitWatchEvents([{ kind: 'update', path: '/repo/.git/index' }], layout);
    expect(main.worktrees.get('main')).toMatchObject({ status: true, head: true });
  });
});
