import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), statuses: vi.fn(), windows: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: mocks.windows } }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { snapshot: mocks.statuses } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
import { collectResourceContext, reportResourceContext } from './context';
beforeEach(() => {
  vi.useFakeTimers(); mocks.send.mockReset();
  mocks.windows.mockReturnValue([{ id: 9, isFocused: () => true, isVisible: () => true, isMinimized: () => false }]);
  mocks.statuses.mockResolvedValue([
    { reading: { running: true, status: 'working' } },
    { reading: { running: true, status: 'needs_user' } },
    { reading: { running: false, status: 'working', background: 'scheduled' } },
    { reading: null },
  ]);
});
afterEach(() => { vi.useRealTimers(); });
it('does no polling before collection, correlates the reply, and preserves canonical runtime facts', async () => {
  expect(mocks.send).not.toHaveBeenCalled();
  const promise = collectResourceContext();
  const { id } = mocks.send.mock.calls[0][1];
  const ui = { observedAt: 0, tab: 'tasks', settings: null, view: 'session', openedTasks: 3, remoteOpenedTasks: 1, auxiliaryWindows: 2 };
  reportResourceContext('wrong request', ui);
  reportResourceContext(id, ui);
  const value = await promise;
  expect(value.ui).toEqual({ ...ui, auxiliaryWindows: 0 });
  expect(value.localTasks).toEqual({ running: 1, waiting: 1, scheduled: 1, unknown: 1 });
  expect(value.windows).toEqual([{ id: 9, focused: true, visible: true, minimized: false }]);
  expect(vi.getTimerCount()).toBe(0);
});
it('marks absent and invalid context unavailable, keeping known runtime counts rather than inventing zeros', async () => {
  const promise = collectResourceContext();
  const id = mocks.send.mock.calls[0][1].id;
  await vi.advanceTimersByTimeAsync(1000);
  expect((await promise).unavailable).toContain('unavailable');
  reportResourceContext(id, {}); // A late reply cannot satisfy the next request.
  const second = collectResourceContext();
  reportResourceContext(mocks.send.mock.lastCall![1].id, { openedTasks: -1 });
  expect((await second).ui).toBeUndefined();
  expect((await second).localTasks?.running).toBe(1);
});
