import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  logError: vi.fn(),
  setSessionParent: vi.fn(),
  /** 每次改父会话时走的是哪台机器(null = 本机)。 */
  machines: [] as Array<string | null>,
  expanded: new Set<string>(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: (machine: string | null) => {
    mocks.machines.push(machine ?? null);
    return { sessions: { setSessionParent: mocks.setSessionParent } };
  },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { expandedSessionIds: mocks.expanded },
}));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, string>) => `${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: mocks.logError } }));

import { machineRegistry } from '@renderer/lib/machine-routing';
import { SESSION_PARENT_CYCLE } from '@shared/core/sessions/sessions';
import { moveSessionUnder } from './set-session-parent-flow';

const child = { projectId: 'remote-project', sessionId: 'child-session', title: 'Child' };
const parent = { projectId: 'local-project', sessionId: 'parent-session', title: 'Parent' };

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.machines.length = 0;
  mocks.expanded.clear();
  machineRegistry.forgetMachine('device-b');
});

describe('moveSessionUnder', () => {
  it("runs the agent's set_parent action on the child's machine, opens the parent and offers one undo back", async () => {
    // child 在别的机器上、父会话在本机:这一步只能在 child 那台做(MCP 的 session_set_parent 也是这样转的)。
    machineRegistry.register('device-b', ['remote-project']);
    mocks.setSessionParent.mockResolvedValue({ parent_session_id: 'parent-session', not_reached: [] });

    moveSessionUnder(child, parent, 'old-parent');
    await settle();

    expect(mocks.machines).toEqual(['device-b']);
    expect(mocks.setSessionParent).toHaveBeenCalledWith('child-session', 'parent-session');
    expect(mocks.expanded.has('parent-session')).toBe(true);
    const shown = mocks.toast.mock.calls[0]![0] as { title: string; description?: string; action: { onClick: () => void } };
    expect(shown.title).toContain('sidebar.nestedUnder');
    expect(shown.description).toBeUndefined();

    shown.action.onClick();
    shown.action.onClick();
    await settle();
    expect(mocks.setSessionParent).toHaveBeenCalledTimes(2);
    expect(mocks.setSessionParent).toHaveBeenLastCalledWith('child-session', 'old-parent');
    expect(mocks.machines).toEqual(['device-b', 'device-b']);
  });

  it('back to the top: the same action with no parent, nothing to open, undo hangs it back where it was', async () => {
    mocks.setSessionParent.mockResolvedValue({ parent_session_id: null, not_reached: [] });

    moveSessionUnder(child, null, 'old-parent');
    await settle();

    expect(mocks.setSessionParent).toHaveBeenCalledWith('child-session', null);
    expect(mocks.expanded.size).toBe(0);
    const shown = mocks.toast.mock.calls[0]![0] as { title: string; action: { onClick: () => void } };
    expect(shown.title).toContain('sidebar.nestedAtTop');
    shown.action.onClick();
    await settle();
    expect(mocks.setSessionParent).toHaveBeenLastCalledWith('child-session', 'old-parent');
  });

  it('a local child stays on this machine even when the parent lives elsewhere', async () => {
    machineRegistry.register('device-b', ['parent-session']);
    mocks.setSessionParent.mockResolvedValue({ parent_session_id: 'parent-session', not_reached: [] });

    moveSessionUnder({ ...child, projectId: 'local-project' }, parent, null);
    await settle();

    expect(mocks.machines).toEqual([null]);
  });

  it("fails loud: the failed action retains the underlying cause in its toast and log", async () => {
    mocks.setSessionParent.mockRejectedValue(new Error('parent session not found on any of your machines (not reached: Studio)'));

    moveSessionUnder(child, parent, null);
    await settle();

    expect(mocks.expanded.size).toBe(0);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive', description: 'parent session not found on any of your machines (not reached: Studio)' })
    );
    expect(String(mocks.logError.mock.calls[0]?.[1]?.error)).toContain('not reached: Studio');
  });

  // 侧栏只看得见侧栏里的会话:成环隔着一条已归档的会话时落点会亮,主进程沿整张图走、以成环拒 —— 提示要说成环,❌ 说「等机器在线」。
  it('a loop the sidebar could not see is told as a loop, not as an offline machine', async () => {
    // IPC 把主进程的错包一层再交过来,原话在里面。
    mocks.setSessionParent.mockRejectedValue(
      new Error(`Error invoking remote method 'sessions.setSessionParent': Error: ${SESSION_PARENT_CYCLE}: session:parent-session is under session:child-session`)
    );

    moveSessionUnder(child, parent, null);
    await settle();

    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('sidebar.nestCycleHint') })
    );
  });
});
