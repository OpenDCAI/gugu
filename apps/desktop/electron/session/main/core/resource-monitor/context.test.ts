import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ statuses: vi.fn(), windows: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: mocks.windows } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { snapshot: mocks.statuses } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
import { collectResourceContext } from './context';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.mockReturnValue([{ id: 9, getTitle: () => 'Editor', isFocused: () => true, isVisible: () => true, isMinimized: () => false, webContents: { send: mocks.send } }]);
  mocks.statuses.mockResolvedValue([
    { reading: { running: true, status: 'working' } },
    { reading: { running: true, status: 'needs_user' } },
    { reading: { running: false, status: 'working', background: 'scheduled' } },
    { reading: null },
  ]);
});
it('collects main-process facts only on demand, without sending IPC or installing a timeout', async () => {
  vi.useFakeTimers();
  try {
    expect(mocks.statuses).not.toHaveBeenCalled();
    expect(mocks.windows).not.toHaveBeenCalled();
    const context = await collectResourceContext();
    expect(context.localTasks).toEqual({ total: 4, running: 1, waiting: 1, scheduled: 1, unknown: 1 });
    expect(context.windows).toEqual([{ id: 9, title: 'Editor', focused: true, visible: true, minimized: false }]);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('keeps window facts and marks task readings unknown on failure', async () => {
  mocks.statuses.mockRejectedValueOnce(new Error('read failed'));
  const context = await collectResourceContext();
  expect(context.localTasks).toBeUndefined();
  expect(context.unavailable).toContain('unavailable');
  expect(context.windows).toHaveLength(1);
});
