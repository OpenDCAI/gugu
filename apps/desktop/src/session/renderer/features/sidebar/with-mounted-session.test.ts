import { beforeEach, describe, expect, it, vi } from 'vitest';

// 一台别的机器 m1 上的项目 p1;会话 s1 只在「挂上、列表读完」以后才进 registry。
const links = new Map<string, string>();
const linkListeners = new Set<() => void>();
const registry = new Map<string, { sessions: Map<string, unknown> }>();
const projects = new Map<string, { mountedProject?: { sessionManager: { listState: string } } | null }>();
const ensureMounted = vi.fn<(projectId: string) => Promise<void>>();
const toast = vi.fn();
let unavailableLabel: string | null = null;

vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: (id: string) => links.get(id) ?? 'closed',
  subscribeMachineLink: (_id: string, listener: () => void) => {
    linkListeners.add(listener);
    return () => linkListeners.delete(listener);
  },
}));
vi.mock('@renderer/lib/machine-routing', () => ({
  machineRegistry: { machineOf: (projectId: string) => (projectId === 'p1' ? 'm1' : null) },
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { device: () => ({ label: 'Mac 1' }) },
}));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: (id: string) => registry.get(id) },
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ ensureMounted, projects }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => unavailableLabel }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, string>) => `${key}:${values?.device ?? ''}`,
}));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { withMountedSession } = await import('./with-mounted-session');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const setLink = (state: string) => {
  links.set('m1', state);
  for (const listener of [...linkListeners]) listener();
};
/** ensureMounted 的结局:挂上并读完(带哪些会话)/ 挂上但列表没读成 / 没挂上(照样 resolve)。 */
const mountEndsAs = (outcome: { listState: 'read' | 'failed'; sessions?: string[] } | 'not-mounted') =>
  ensureMounted.mockImplementation(async () => {
    if (outcome === 'not-mounted') {
      projects.set('p1', { mountedProject: null });
      return;
    }
    projects.set('p1', { mountedProject: { sessionManager: { listState: outcome.listState } } });
    for (const id of outcome.sessions ?? []) registry.set(id, { sessions: new Map([[id, { data: { id } }]]) });
  });
const toasted = () => toast.mock.calls.map(([arg]) => (arg as { title: string }).title);

beforeEach(() => {
  links.clear();
  linkListeners.clear();
  registry.clear();
  projects.clear();
  ensureMounted.mockReset();
  toast.mockReset();
  unavailableLabel = null;
});

describe('withMountedSession —— 人在一条还没挂的远程行上动手', () => {
  // 复核 142:离线机器的行来自底稿,动作画在行上;排队等它连上,确认框会在几小时后突然弹出来。
  it('那台机器没连上(closed):当场说,❌ 排队;之后连上也不会冒出这次动作', async () => {
    mountEndsAs({ listState: 'read', sessions: ['s1'] });
    const run = vi.fn();
    withMountedSession('p1', 's1', run);
    expect(toasted()).toEqual(['remoteHost.status.offlineNever:Mac 1']);
    setLink('open');
    await flush();
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('太旧 / 不可用也是当场说没连上', () => {
    for (const state of ['tooOld', 'unavailable']) {
      links.set('m1', state);
      withMountedSession('p1', 's1', vi.fn());
    }
    expect(toasted()).toEqual(['remoteHost.status.offlineNever:Mac 1', 'remoteHost.status.offlineNever:Mac 1']);
  });

  // 与侧栏那颗点同一个判据:connecting 时点显示连着,动作就等这一回。
  it('正在连(connecting):连上了就挂上再做', async () => {
    links.set('m1', 'connecting');
    mountEndsAs({ listState: 'read', sessions: ['s1'] });
    const run = vi.fn();
    withMountedSession('p1', 's1', run);
    expect(toast).not.toHaveBeenCalled();
    setLink('open');
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('正在连、中途断了:当场说没连上、放弃;之后再连上也不冒出这次动作', async () => {
    links.set('m1', 'connecting');
    mountEndsAs({ listState: 'read', sessions: ['s1'] });
    const run = vi.fn();
    withMountedSession('p1', 's1', run);
    setLink('closed');
    expect(toasted()).toEqual(['remoteHost.status.offlineNever:Mac 1']);
    setLink('open');
    await flush();
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(linkListeners.size).toBe(0);
  });

  it('连着:先挂上再做,拿到挂好的那条', async () => {
    links.set('m1', 'open');
    mountEndsAs({ listState: 'read', sessions: ['s1'] });
    const run = vi.fn();
    withMountedSession('p1', 's1', run);
    expect(run).not.toHaveBeenCalled();
    await flush();
    expect(ensureMounted).toHaveBeenCalledWith('p1');
    expect(run).toHaveBeenCalledWith({ data: { id: 's1' } }, registry.get('s1'));
    expect(toast).not.toHaveBeenCalled();
  });

  it('挂上了、列表也读完了还找不到:才说「那台机器上已经没有这条」', async () => {
    links.set('m1', 'open');
    mountEndsAs({ listState: 'read' });
    withMountedSession('p1', 's1', vi.fn());
    await flush();
    expect(toasted()).toEqual(['task.remoteActionMissing:Mac 1']);
  });

  // ensureMounted 在没挂上时也 resolve(openProject 没成 / 列表读挂了被吃掉):❌ 说成「没有这条」。
  it('挂载没成却 resolve:线还通 = 准备失败;列表没读成 = 准备失败', async () => {
    links.set('m1', 'open');
    mountEndsAs('not-mounted');
    withMountedSession('p1', 's1', vi.fn());
    await flush();
    mountEndsAs({ listState: 'failed' });
    withMountedSession('p1', 's1', vi.fn());
    await flush();
    expect(toasted()).toEqual(['task.setUpWorkspaceFailed:Mac 1', 'task.setUpWorkspaceFailed:Mac 1']);
  });

  it('挂的时候线断了(没挂上):说没连上', async () => {
    links.set('m1', 'open');
    ensureMounted.mockImplementation(async () => {
      links.set('m1', 'closed');
      projects.set('p1', { mountedProject: null });
    });
    withMountedSession('p1', 's1', vi.fn());
    await flush();
    expect(toasted()).toEqual(['remoteHost.status.offlineNever:Mac 1']);
  });

  it('已经挂着:当场做,不问连接', () => {
    registry.set('s1', { sessions: new Map([['s1', { data: { id: 's1' } }]]) });
    const run = vi.fn();
    withMountedSession('p1', 's1', run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ensureMounted).not.toHaveBeenCalled();
  });

  it('uses the task page machine-status wording in its offline notification', () => {
    unavailableLabel = 'Mac 1 is offline';
    withMountedSession('p1', 's1', vi.fn());
    expect(toasted()).toEqual(['Mac 1 is offline']);
    expect(ensureMounted).not.toHaveBeenCalled();
  });
});
