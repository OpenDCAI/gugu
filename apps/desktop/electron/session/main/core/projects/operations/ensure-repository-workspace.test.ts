import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';

const mocks = vi.hoisted(() => ({
  selectAll: vi.fn(),
  insertRun: vi.fn(),
  updateRun: vi.fn(),
  transaction: vi.fn(),
}));

function makeSelectChain(results: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: () => ({
          all: () => results,
        }),
      }),
    }),
  };
}

function makeInsertChain(captureValues?: unknown[]) {
  return {
    values: (vals: unknown) => {
      captureValues?.push(vals);
      return { run: mocks.insertRun };
    },
  };
}

function makeUpdateChain(captureSets?: unknown[]) {
  return {
    set: (vals: unknown) => {
      captureSets?.push(vals);
      return {
        where: () => ({
          run: mocks.updateRun,
        }),
      };
    },
  };
}

vi.mock('@main/db/client', () => ({
  db: {
    select: () => makeSelectChain(mocks.selectAll()),
    transaction: mocks.transaction,
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const localProject = {
  type: 'local' as const,
  id: 'project-1',
  name: 'My Project',
  path: '/home/user/project',
  baseRef: 'main',
  repositoryWorkspaceId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ensureRepositoryWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a new project-root workspace inside a transaction when not set', () => {
    mocks.selectAll.mockReturnValue([{ repositoryWorkspaceId: null }]);

    const insertedValues: unknown[] = [];

    mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        select: () => makeSelectChain([{ repositoryWorkspaceId: null }]),
        insert: () => makeInsertChain(insertedValues),
        update: () => makeUpdateChain(),
      };
      // First tx.select for re-check returns null
      // Second tx.select for existing key returns empty
      let selectCallCount = 0;
      tx.select = () => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([{ repositoryWorkspaceId: null }]);
        return makeSelectChain([]);
      };
      return fn(tx);
    });

    const result = ensureRepositoryWorkspace(localProject);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(mocks.insertRun).toHaveBeenCalled();
    expect(mocks.updateRun).toHaveBeenCalled();

    const wsInsert = insertedValues[0] as Record<string, unknown>;
    expect(wsInsert.kind).toBe('project-root');
    expect(wsInsert.location).toBe('local');
    expect(wsInsert.path).toBe(localProject.path);
    expect(wsInsert.sshConnectionId).toBeNull();
  });

  // @@@5173 owner 在验收实例上撞到:任务点开是「这个任务没有文件记录,打不开」,而库里
  // `projects.repositoryWorkspaceId` 指着一行**已经不存在**的工作区。这条引用从前没人核对过 ——
  // createSession 的 repository-instance 分支照抄它写进任务行,直到打开任务才发现指空。于是那不是
  // 坏掉一条任务,是整个项目永久钉死:老任务全打不开,新建的任务照样抄到同一个悬空 id。
  it('recreates the project-root row under the same id when the stored one points at nothing', () => {
    // 顶层:① 项目行记着 ws-gone ② 那一行查不到 ⇒ 必须进事务修
    mocks.selectAll
      .mockReturnValueOnce([{ repositoryWorkspaceId: 'ws-gone' }])
      .mockReturnValueOnce([]);

    const insertedValues: unknown[] = [];
    const updateSets: unknown[] = [];

    mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      let selectCallCount = 0;
      const tx = {
        select: () => {
          selectCallCount++;
          // ① 事务内复查项目行 ② 复查那一行还在不在 ③ 按 key 找孤儿行
          if (selectCallCount === 1) return makeSelectChain([{ repositoryWorkspaceId: 'ws-gone' }]);
          return makeSelectChain([]);
        },
        insert: () => makeInsertChain(insertedValues),
        update: () => makeUpdateChain(updateSets),
      };
      return fn(tx);
    });

    const result = ensureRepositoryWorkspace(localProject);

    // 沿用同一个 id 是这条修复的全部意义:❌ 发新 uuid 的话,行建出来了,而指着旧 id 的
    // 那些任务行一条都救不回来。
    expect(result).toBe('ws-gone');
    const wsInsert = insertedValues[0] as Record<string, unknown>;
    expect(wsInsert.id).toBe('ws-gone');
    expect(wsInsert.kind).toBe('project-root');
    // 沿用得上就不必迁任务行,所以只更新项目那一处。
    expect(updateSets).toEqual([{ repositoryWorkspaceId: 'ws-gone' }]);
  });

  it('relinks tasks off the dangling id when another row already owns the key', () => {
    mocks.selectAll
      .mockReturnValueOnce([{ repositoryWorkspaceId: 'ws-gone' }])
      .mockReturnValueOnce([]);

    const insertedValues: unknown[] = [];
    const updateSets: unknown[] = [];

    mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      let selectCallCount = 0;
      const tx = {
        select: () => {
          selectCallCount++;
          if (selectCallCount === 1) return makeSelectChain([{ repositoryWorkspaceId: 'ws-gone' }]);
          if (selectCallCount === 2) return makeSelectChain([]);
          return makeSelectChain([{ id: 'ws-orphan' }]);
        },
        insert: () => makeInsertChain(insertedValues),
        update: () => makeUpdateChain(updateSets),
      };
      return fn(tx);
    });

    const result = ensureRepositoryWorkspace(localProject);

    expect(result).toBe('ws-orphan');
    expect(insertedValues).toHaveLength(0);
    // 项目改指孤儿行之后,指着旧 id 的任务行必须跟着迁 —— 否则它们仍然指空。
    expect(updateSets).toEqual([
      { repositoryWorkspaceId: 'ws-orphan' },
      { workspaceId: 'ws-orphan' },
    ]);
  });

  it('reuses existing workspace row when key already exists (orphan recovery)', () => {
    mocks.selectAll.mockReturnValue([{ repositoryWorkspaceId: null }]);

    mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
      let selectCallCount = 0;
      const tx = {
        select: () => {
          selectCallCount++;
          if (selectCallCount === 1) return makeSelectChain([{ repositoryWorkspaceId: null }]);
          return makeSelectChain([{ id: 'ws-orphan-existing' }]);
        },
        insert: () => makeInsertChain(),
        update: () => makeUpdateChain(),
      };
      return fn(tx);
    });

    const result = ensureRepositoryWorkspace(localProject);

    expect(result).toBe('ws-orphan-existing');
    expect(mocks.insertRun).not.toHaveBeenCalled();
    expect(mocks.updateRun).toHaveBeenCalled();
  });
});
