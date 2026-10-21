import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * spec session-page「会话历史」(#6083)坑 ①:`restoreSession` 只够一半 —— 库里抹掉章之后,渲染侧还没有这一行。
 * 这里钉的是「恢复 = 库 + 渲染侧那一份」两件事都发生,且顺序对:那一份要在项目挂上之后才放行,否则放进一张
 * 还不存在的表。
 */
const mocks = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  ensureProjectLoaded: vi.fn(),
  acceptCreatedSession: vi.fn(),
  order: [] as string[],
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { sessions: { restoreSession: mocks.restoreSession } },
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({
    ensureProjectLoaded: (...args: unknown[]) => {
      mocks.order.push('project');
      return mocks.ensureProjectLoaded(...args);
    },
  }),
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: () => ({
    acceptCreatedSession: (...args: unknown[]) => {
      mocks.order.push('session');
      return mocks.acceptCreatedSession(...args);
    },
  }),
}));

import { restoreArchivedSession } from './restore-session-flow';

const ref = { projectId: 'p1', sessionId: 'c1' };
const restoredRow = { id: 'c1', projectId: 'p1', title: 'x', archivedAt: null };

describe('restoreArchivedSession', () => {
  beforeEach(() => {
    for (const fn of [mocks.restoreSession, mocks.ensureProjectLoaded, mocks.acceptCreatedSession]) {
      fn.mockReset();
    }
    mocks.order.length = 0;
    mocks.restoreSession.mockResolvedValue(restoredRow);
    mocks.ensureProjectLoaded.mockResolvedValue(undefined);
  });

  it('库与渲染侧两处都动,且渲染侧那一份在项目挂上之后才放行', async () => {
    const result = await restoreArchivedSession(ref);

    expect(mocks.restoreSession).toHaveBeenCalledWith('p1', 'c1');
    expect(mocks.ensureProjectLoaded).toHaveBeenCalledWith('p1');
    expect(mocks.acceptCreatedSession).toHaveBeenCalledWith(restoredRow);
    expect(mocks.order).toEqual(['project', 'session']);
    expect(result).toBe(restoredRow);
  });

  it('库那一步失败就整个失败,渲染侧一个字都不动 —— ❌ 列表里有、库里还归着', async () => {
    mocks.restoreSession.mockRejectedValue(new Error('nope'));

    await expect(restoreArchivedSession(ref)).rejects.toThrow('nope');

    expect(mocks.acceptCreatedSession).not.toHaveBeenCalled();
  });
});
