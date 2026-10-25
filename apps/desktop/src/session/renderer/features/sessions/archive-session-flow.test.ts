import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * spec session-page-flows「归档要有去处」(#6083):归档成功后提示里说得出「在会话历史里能找回」,并给一次撤销;
 * 撤销按主进程报回的清单原样放回(点名的 + 勾了范围时的子会话),走恢复的唯一路径;只能撤一次。
 */
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  showModal: vi.fn(),
  leaveSessionView: vi.fn(),
  restore: vi.fn(),
  archiveSession: vi.fn(),
  settings: { confirmBeforeArchive: false } as { confirmBeforeArchive?: boolean } | undefined,
}));

vi.mock('@renderer/features/settings/app-settings-client', () => ({
  getAppSettingValueSnapshot: () => mocks.settings,
  setAppSettingsValueInCache: vi.fn(),
  updateAppSettingsRequest: vi.fn(() => Promise.resolve()),
  invalidateAppSettingsKey: vi.fn(),
}));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: mocks.leaveSessionView }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: mocks.showModal }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('./restore-session-flow', () => ({ restoreArchivedSession: mocks.restore }));

const sessions = new Map([
  ['root', { data: {} }],
  ['child', { data: { parentSessionId: 'root' } }],
]);
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({ sessions, archiveSession: mocks.archiveSession }),
    allSessions: () => sessions,
  },
}));

import { requestArchiveSession } from './archive-session-flow';

type ToastArg = { title: string; description?: string; action?: { label: string; onClick: () => void } };

const ref = (sessionId: string) => ({ projectId: 'p1', sessionId });
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const undoToast = () =>
  mocks.toast.mock.calls.map(([arg]) => arg as ToastArg).find((arg) => arg.title === 'task.archivedToast');

describe('归档提示与撤销', () => {
  beforeEach(() => {
    for (const fn of [mocks.toast, mocks.showModal, mocks.leaveSessionView, mocks.restore, mocks.archiveSession]) {
      fn.mockReset();
    }
    mocks.settings = { confirmBeforeArchive: false };
    mocks.restore.mockResolvedValue(undefined);
    mocks.archiveSession.mockResolvedValue({ archived: [ref('child'), ref('root')], unreached: [] });
  });

  it('归档成功后提示说得出去处,并给一次撤销;撤销按主进程的清单逐条放回,第二下不再跑', async () => {
    requestArchiveSession({ projectId: 'p1', sessionId: 'root' });
    await flush();

    const shown = undoToast();
    expect(shown?.description).toBe('task.archivedToastHint');
    expect(shown?.action?.label).toBe('task.archiveUndo');

    shown!.action!.onClick();
    await flush();
    expect(mocks.restore.mock.calls.map(([r]) => r)).toEqual([ref('child'), ref('root')]);

    shown!.action!.onClick();
    await flush();
    expect(mocks.restore).toHaveBeenCalledTimes(2);
  });

  it('主进程说这一次什么都没收走(已经归档过)时不摆撤销 —— 撤销一个没发生的动作是假按钮', async () => {
    mocks.archiveSession.mockResolvedValue({ archived: [], unreached: [] });
    requestArchiveSession({ projectId: 'p1', sessionId: 'root' });
    await flush();
    expect(undoToast()).toBeUndefined();
  });

  it('撤销放回失败要说出来,并指向会话历史', async () => {
    mocks.restore.mockRejectedValue(new Error('nope'));
    requestArchiveSession({ projectId: 'p1', sessionId: 'root' });
    await flush();
    undoToast()!.action!.onClick();
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'nope', description: 'task.archiveUndoFailedHint' })
    );
  });

  // owner 2026-10-01「一起收」:子会话可以在别的机器上;够不着的那几台要说出来(动作本身成了,不是失败提示)。
  it('这次够不着的机器说出来,一台只说一次;连别的机器都没问成时说「其它机器」', async () => {
    mocks.archiveSession.mockResolvedValue({
      archived: [ref('root')],
      unreached: [
        { deviceId: 'dev-c', label: 'laptop', detail: 'offline' },
        { deviceId: 'dev-c', label: 'laptop', detail: 'offline' },
        { deviceId: null, label: null, detail: 'other machines were not asked' },
      ],
    });
    requestArchiveSession({ projectId: 'p1', sessionId: 'root' });
    await flush();
    expect(undoToast()).toBeDefined();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'task.childrenNotReached',
      description: `task.childrenNotReachedHint ${JSON.stringify({ machines: 'laptop, task.anotherMachine' })}`,
    });
  });

  it('归档失败时不摆撤销(没有东西可撤),照旧报失败', async () => {
    mocks.archiveSession.mockRejectedValue(new Error('archive failed'));
    requestArchiveSession({ projectId: 'p1', sessionId: 'root' });
    await flush();
    expect(undoToast()).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'task.archiveTaskFailed' }));
  });
});
