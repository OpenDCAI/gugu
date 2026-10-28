import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@renderer/features/sessions/session-home-project-constants';
import { events } from '@renderer/lib/ipc';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { blockKey } from '@/lib/sidebarJoinedGroups';
import { SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => {
  const ipc = {
  events: {
    on: vi.fn(),
  },
  rpc: {},
};
  // 本机(null)那条线就是 events.on;测试里的项目都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
});

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    rowSessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function projectManager(
  projects: { id: string; createdAt: string; name?: string }[]
): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, mountedProject: null }])),
  } as unknown as SidebarProjectManager;
}

function sessionFixture(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function projectManagerWithSessions(
  projects: {
    id: string;
    createdAt: string;
    sessionIds: string[];
  }[]
): SidebarProjectManager {
  return {
    projects: new Map(
      projects.map((project) => [
        project.id,
        {
          id: project.id,
          createdAt: project.createdAt,
          mountedProject: {
            sessionManager: {
              sessions: new Map(
                project.sessionIds.map((sessionId, index) => [
                  sessionId,
                  sessionFixture(sessionId, `2026-01-01T00:00:0${index}.000Z`),
                ])
              ),
            },
          },
        },
      ])
    ),
  } as unknown as SidebarProjectManager;
}

describe('SidebarStore project ordering', () => {
  it('counts a projectless child once when its workspace is also folded into a project group (#574)', () => {
    const home = IMPLICIT_SESSION_HOME_PROJECT_ID;
    const row = 'hydration-project';
    const parent = 'hydration-parent';
    const child = 'hydration-child';
    sessionRegistry.acquire(parent, row, [{
      id: parent, projectId: row, providerId: 'codex', title: 'Parent', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:02.000Z', agentStatus: null,
    }]);
    sessionRegistry.acquire(child, home, [{
      id: child, projectId: home, providerId: 'codex', title: 'Child', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:01.000Z', agentStatus: 'needs_user', parentSessionId: parent,
    }]);
    const store = new SidebarStore(projectManagerWithSessions([
      { id: row, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [parent] },
      { id: home, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [child] },
    ]));
    store.machines = {
      machineOf: () => null, label: () => null, homeDir: () => null,
      projectGroupOf: () => 'shared-project-chat',
      projectGroupRepresentativeOf: (id) => id === row,
    };
    try {
      // Both page registries are unique. The aggregation reads the child through
      // the folded project and again through standaloneOwnEntries().
      expect(store.homeLayout.folded.get(row)).toEqual([home]);
      expect(sessionRegistry.get(child)?.sessions.size).toBe(1);
      store.ensureProjectExpanded(row);
      store.toggleSessionExpanded(parent);
      expect(store.needsYouCountForProject(row)).toBe(1);
      expect(store.projectsNeedYouCount).toBe(1);
      expect(store.sidebarRows.filter((entry) => entry.kind === 'conversation').map((entry) => entry.sessionId))
        .toEqual([parent, child]);
      expect(store.standaloneSessionEntries).toEqual([]);
    } finally {
      sessionRegistry.release(parent);
      sessionRegistry.release(child);
    }
  });

  it('persists and restores expanded conversation rows', () => {
    const source = new SidebarStore(projectManager([]));
    source.toggleSessionExpanded('parent-conversation');

    const restored = new SidebarStore(projectManager([]));
    restored.restoreSnapshot(source.snapshot);

    expect([...restored.expandedSessionIds]).toEqual(['parent-conversation']);
  });

  it('keeps a restored collapsed project collapsed when its tasks load', () => {
    const sessions = observable.map<string, ReturnType<typeof sessionFixture>>();
    const store = new SidebarStore({
      projects: new Map([
        [
          'project-1',
          {
            id: 'project-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mountedProject: { sessionManager: { sessions } },
          },
        ],
      ]),
    } as unknown as SidebarProjectManager);
    store.restoreSnapshot({ expandedProjectIds: [] });

    runInAction(() => sessions.set('task-1', sessionFixture('task-1', '2026-01-01T00:00:00.000Z')));

    expect(store.expandedProjectIds.has('project-1')).toBe(false);
  });

  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('hides the app-owned project that backs projectless tasks', () => {
    const store = new SidebarStore(
      projectManager([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: '任务工作区',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
        { id: 'same-name', name: '任务工作区', createdAt: '2026-01-04T00:00:00.000Z' },
        { id: 'visible', name: 'Visible', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['same-name', 'visible']);
    expect(store.isEmpty).toBe(false);

    const hiddenOnly = new SidebarStore(
      projectManager([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: '任务工作区',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ])
    );
    expect(hiddenOnly.orderedProjects).toEqual([]);
    expect(hiddenOnly.isEmpty).toBe(true);
  });

  it('keeps a pinned parent and its descendants together as one collapsible tree', () => {
    sessionRegistry.acquire('task-1', 'project-1', [
      {
        id: 'parent',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Parent',
        lastInteractedAt: '2026-01-01T00:00:02.000Z',
        runtime: 'acp',
        isPinned: true,
      },
      {
        id: 'child',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Child',
        lastInteractedAt: '2026-01-01T00:00:01.000Z',
        runtime: 'acp',
        parentSessionId: 'parent',
      },
    ]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['task-1'],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');

    expect(store.sidebarRows.filter((row) => row.kind === 'conversation')).toEqual([]);
    expect(store.pinnedSessionEntries).toEqual([
      {
        projectId: 'project-1',
        sessionId: 'parent',
        depth: 0,
        hasChildren: true,
        needsAttention: false,
      },
    ]);

    store.toggleSessionExpanded('parent');
    expect(
      store.pinnedSessionEntries.map(({ sessionId: rowSessionId, depth }) => ({
        rowSessionId,
        depth,
      }))
    ).toEqual([
      { rowSessionId: 'parent', depth: 0 },
      { rowSessionId: 'child', depth: 1 },
    ]);

    sessionRegistry.release('task-1');
  });

  // 侧栏拖一条会话到另一条上 = 挂到它下面:落点只给挂得上的行 —— 已经挂在这里的、它自己的子孙(成环)不给。
  it('answers who a session hangs under and whether a row sits in its subtree', () => {
    const row = (id: string, parentSessionId?: string) => ({
      id,
      projectId: 'project-1',
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:01.000Z',
      runtime: 'acp' as const,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    sessionRegistry.acquire('top', 'project-1', [row('top')]);
    sessionRegistry.acquire('mid', 'project-1', [row('mid', 'top')]);
    sessionRegistry.acquire('leaf', 'project-1', [row('leaf', 'mid')]);
    sessionRegistry.acquire('other', 'project-1', [row('other')]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['top', 'mid', 'leaf', 'other'] },
      ])
    );

    expect(store.parentOf('leaf')).toBe('mid');
    expect(store.parentOf('top')).toBeNull();
    expect(store.parentOf('missing')).toBeNull();
    // `top` 往 `leaf` 下面挂:leaf 在 top 的子树里 ⇒ 成环,不给落点。
    expect(store.isWithin('leaf', 'top')).toBe(true);
    expect(store.isWithin('top', 'top')).toBe(true);
    // 反过来、旁支都挂得上。
    expect(store.isWithin('top', 'leaf')).toBe(false);
    expect(store.isWithin('other', 'top')).toBe(false);

    for (const id of ['top', 'mid', 'leaf', 'other']) sessionRegistry.release(id);
  });

  // 拖出来回到根的落点 = 它不挂着时本来显示的那一行:自己的项目行,或「任务」分区(null)—— 不是它此刻跟着父会话显示的那一行。
  it('knows the row a nested session returns to when it hangs under nobody', () => {
    const row = (id: string, projectId: string, parentSessionId?: string) => ({
      id,
      projectId,
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:01.000Z',
      runtime: 'acp' as const,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    sessionRegistry.acquire('standalone-parent', IMPLICIT_SESSION_HOME_PROJECT_ID, [row('standalone-parent', IMPLICIT_SESSION_HOME_PROJECT_ID)]);
    sessionRegistry.acquire('project-child', 'project-1', [row('project-child', 'project-1', 'standalone-parent')]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['standalone-parent'] },
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['project-child'] },
      ])
    );

    // 此刻 child 跟着父会话显示在「任务」分区里……
    expect(store.rowOfSession('project-1', 'project-child')).toBeNull();
    // ……回到根时它在自己的项目行。
    expect(store.rootRowOf('project-child')).toBe('project-1');
    expect(store.rootRowOf('standalone-parent')).toBeNull();
    expect(store.rootRowOf('missing')).toBeUndefined();

    for (const id of ['standalone-parent', 'project-child']) sessionRegistry.release(id);
  });

  it('keeps a pinned parent tree together when its child lives in a task of its own (#5665)', () => {
    sessionRegistry.acquire('task-parent', 'project-1', [
      {
        id: 'parent',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Parent',
        lastInteractedAt: '2026-01-01T00:00:02.000Z',
        runtime: 'acp',
        isPinned: true,
      },
    ]);
    sessionRegistry.acquire('task-child', 'project-1', [
      {
        id: 'child',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Child',
        lastInteractedAt: '2026-01-01T00:00:01.000Z',
        runtime: 'acp',
        parentSessionId: 'parent',
      },
    ]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['task-parent', 'task-child'],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.toggleSessionExpanded('parent');

    expect(
      store.pinnedSessionEntries.map(({ sessionId: rowSessionId, depth }) => ({
        rowSessionId,
        depth,
      }))
    ).toEqual([
      { rowSessionId: 'parent', depth: 0 },
      { rowSessionId: 'child', depth: 1 },
    ]);
    // 孩子随置顶的父会话进了置顶区,项目区里不再单独出现一行。
    expect(store.sidebarRows.filter((row) => row.kind === 'conversation')).toEqual([]);

    sessionRegistry.release('task-parent');
    sessionRegistry.release('task-child');
  });

  it('keeps a needs-you child visible in its working parent tree and propagates attention', () => {
    vi.mocked(events.on).mockClear();
    sessionRegistry.acquire('task-status', 'project-status', [
      {
        id: 'working-parent',
        projectId: 'project-status',
        providerId: 'codex',
        title: 'Working parent',
        lastInteractedAt: '2026-01-01T00:00:02.000Z',
        runtime: 'pty',
        agentStatus: 'working',
      },
      {
        id: 'needs-you-child',
        projectId: 'project-status',
        providerId: 'codex',
        title: 'Needs-you child',
        lastInteractedAt: '2026-01-01T00:00:01.000Z',
        runtime: 'pty',
        agentStatus: 'needs_user',
        parentSessionId: 'working-parent',
      },
    ]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: 'project-status',
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['task-status'],
        },
      ])
    );
    store.ensureProjectExpanded('project-status');
    expect(store.expandedSessionIds.has('working-parent')).toBe(false);
    const createdListener = vi
      .mocked(events.on)
      .mock.calls.filter(([channel]) => channel === sessionCreatedChannel)
      .at(-1)?.[1] as
      | ((payload: { session: { parentSessionId?: string | null } }) => void)
      | undefined;
    expect(createdListener).toBeTypeOf('function');
    createdListener?.({ session: { parentSessionId: 'working-parent' } });
    expect(store.expandedSessionIds.has('working-parent')).toBe(true);

    expect(
      store.sidebarRows
        .filter((row) => row.kind === 'conversation')
        .map(({ sessionId: rowSessionId, group, depth, hasChildren, needsAttention }) => ({
          rowSessionId,
          group,
          depth,
          hasChildren,
          needsAttention,
        }))
    ).toEqual([
      {
        rowSessionId: 'working-parent',
        group: 'working',
        depth: 0,
        hasChildren: true,
        needsAttention: true,
      },
      {
        rowSessionId: 'needs-you-child',
        group: 'working',
        depth: 1,
        hasChildren: false,
        needsAttention: true,
      },
    ]);

    sessionRegistry.release('task-status');
  });

  it('lists a session of the implicit home project in the Tasks section', () => {
    sessionRegistry.acquire('legacy-task', IMPLICIT_SESSION_HOME_PROJECT_ID, [
      {
        id: 'legacy-conv',
        projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
        providerId: 'claude',
        title: '老行',
        lastInteractedAt: '2026-01-01T00:00:05.000Z',
        runtime: 'pty',
        agentStatus: 'needs_user',
      },
    ]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['legacy-task'],
        },
      ])
    );

    expect(store.standaloneSessionEntries.map((e) => e.sessionId)).toContain('legacy-conv');
  });

  it('#609 a workspace this computer keeps (kind workspace: ~, the assistant\'s directories) is no project row; its sessions are Tasks', () => {
    sessionRegistry.acquire('home-task', 'home-workspace', [
      { id: 'home-conv', projectId: 'home-workspace', providerId: 'claude', title: 'in ~', lastInteractedAt: '2026-01-01T00:00:05.000Z', runtime: 'pty', agentStatus: 'idle' },
    ]);
    const manager = projectManagerWithSessions([
      { id: 'home-workspace', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['home-task'] },
      { id: 'code', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: [] },
    ]);
    (manager.projects.get('home-workspace') as unknown as { data: { kind: string } }).data = { kind: 'workspace' };
    const store = new SidebarStore(manager);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['code']);
    expect(store.standaloneSessionEntries.map((e) => e.sessionId)).toContain('home-conv');
    sessionRegistry.release('home-task');
  });

  it('keeps executors in the Sessions section when the assistant home project row is hidden', () => {
    const home = 'assistant-home';
    const record = (id: string, parentSessionId?: string) => ({
      id, projectId: home, providerId: 'codex', title: id, runtime: 'acp' as const,
      agentStatus: 'idle' as const, parentSessionId,
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
    });
    const records = [record('own'), record('executor', 'own'), record('grandchild', 'executor'), record('other')];
    for (const record of records) sessionRegistry.acquire(record.id, home, [record]);
    const identity = vi.spyOn(sessionAgentNames, 'identityFor').mockImplementation((id) =>
      id === 'own' ? { agentUserId: 'assistant', displayName: 'renamed assistant' } : undefined);
    try {
      const manager = projectManagerWithSessions([
        { id: home, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: records.map((r) => r.id) },
        { id: 'business', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [] },
      ]);
      const store = new SidebarStore(manager);
      store.setAssistantAgentId('assistant');
      store.setAssistantHomeProjectId(home);
      store.expandedSessionIds.add('executor');
      expect(store.orderedProjects.map((p) => p.id)).toEqual(['business']);
      expect(store.standaloneSessionEntries.map((r) => [r.sessionId, r.depth])).toEqual([
        ['executor', 0], ['grandchild', 1], ['other', 0],
      ]);
      expect(store.rowOfSession(home, 'executor')).toBeNull();
      expect(store.navChain.some((r) => r.kind === 'conversation' && r.sessionId === 'executor')).toBe(true);
      // With the project visible again its sessions return to the project, without duplicates.
      store.setAssistantHomeProjectId(null);
      expect(store.standaloneSessionEntries).toEqual([]);
      expect(manager.projects.size).toBe(2);
    } finally {
      identity.mockRestore();
      for (const record of records) sessionRegistry.release(record.id);
    }
  });

  it('keeps task-home child sessions folded under their standalone parent', () => {
    vi.mocked(events.on).mockClear();
    sessionRegistry.acquire('task-home-session', IMPLICIT_SESSION_HOME_PROJECT_ID, [
      {
        id: 'task-home-parent',
        projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
        providerId: 'codex',
        title: 'Task-home parent',
        lastInteractedAt: '2026-01-01T00:00:02.000Z',
        runtime: 'acp',
        agentStatus: 'working',
      },
      {
        id: 'task-home-child',
        projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
        providerId: 'codex',
        title: 'Task-home child',
        lastInteractedAt: '2026-01-01T00:00:01.000Z',
        runtime: 'acp',
        agentStatus: 'needs_user',
        parentSessionId: 'task-home-parent',
      },
    ]);
    const store = new SidebarStore(
      projectManagerWithSessions([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['task-home-session'],
        },
      ])
    );
    // 二级分类默认关(owner 2026-09-06),这一条测的是分组开着时的形状,所以显式打开。
    store.setStateGroupsEnabled(true);
    const createdListener = vi
      .mocked(events.on)
      .mock.calls.filter(([channel]) => channel === sessionCreatedChannel)
      .at(-1)?.[1] as
      | ((payload: { session: { parentSessionId?: string | null } }) => void)
      | undefined;
    createdListener?.({ session: { parentSessionId: 'task-home-parent' } });

    expect(store.standaloneSessionGroups).toEqual([
      {
        group: 'working',
        entries: [
          {
            projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
            sessionId: 'task-home-parent',
            depth: 0,
            hasChildren: true,
            needsAttention: true,
          },
          {
            projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
            sessionId: 'task-home-child',
            depth: 1,
            hasChildren: false,
            needsAttention: true,
            parentProjectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
          },
        ],
      },
    ]);

    sessionRegistry.release('task-home-session');
  });
});

describe('SidebarStore keyboard navigation chain', () => {
  function session(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      projectId: 'project-nav',
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
      type: 'acp',
      ...extra,
    };
  }

  it('runs New task → pinned → project rows and their sessions, and skips collapsed projects', () => {
    sessionRegistry.acquire('task-nav', 'project-nav', [
      session('pinned-one', { isPinned: true }),
      session('plain-one'),
    ] as never);
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-nav', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-nav'] },
      ])
    );

    // Collapsed: the project is still a station, but nothing inside it is — collapsing means
    // "skip this whole thing", not "auto-expand when the cursor arrives".
    expect(store.navChain).toEqual([
      { kind: 'new-session' },
      {
        kind: 'conversation',
        projectId: 'project-nav',
        sessionId: 'pinned-one',
      },
      { kind: 'project', projectId: 'project-nav' },
    ]);

    store.ensureProjectExpanded('project-nav');
    expect(store.navChain.map((node) => node.kind)).toEqual([
      'new-session',
      'conversation',
      'project',
      'conversation',
    ]);

    sessionRegistry.release('task-nav');
  });

  it('drops a collapsed Pinned section out of the chain', () => {
    sessionRegistry.acquire('task-nav', 'project-nav', [
      session('pinned-one', { isPinned: true }),
    ] as never);
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-nav', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-nav'] },
      ])
    );
    expect(store.navChain.some((node) => node.kind === 'conversation')).toBe(true);

    store.togglePinnedCollapsed();
    expect(store.navChain.some((node) => node.kind === 'conversation')).toBe(false);

    sessionRegistry.release('task-nav');
  });

  it('reports the idle overflow that hides the next station, so ↓ can walk past "Show more"', () => {
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    sessionRegistry.acquire(
      'task-nav',
      'project-nav',
      ids.map((id, index) =>
        session(id, {
          lastInteractedAt: `2026-01-0${6 - index}T00:00:00.000Z`,
        })
      ) as never
    );
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-nav', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-nav'] },
      ])
    );
    store.ensureProjectExpanded('project-nav');
    // 「空闲超量收起」只存在于分组开着的时候 —— 默认已关,这里显式打开。
    store.setStateGroupsEnabled(true);

    const visible = store.navChain.filter((node) => node.kind === 'conversation');
    expect(visible).toHaveLength(5);
    const last = visible[visible.length - 1];
    expect(store.idleOverflowProjectAfter(last)).toBe('project-nav');
    // Negative control: a station that is not the last visible one has nothing hidden after it.
    expect(store.idleOverflowProjectAfter(visible[0])).toBeNull();

    store.ensureIdleExpanded('project-nav');
    expect(store.navChain.filter((node) => node.kind === 'conversation')).toHaveLength(6);
    expect(store.idleOverflowProjectAfter(last)).toBeNull();

    sessionRegistry.release('task-nav');
  });

  it('counts the Tasks section roots once, before and after "Show more" is opened', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    sessionRegistry.acquire(
      'task-home-count',
      IMPLICIT_SESSION_HOME_PROJECT_ID,
      ids.map((id, index) =>
        session(id, { projectId: IMPLICIT_SESSION_HOME_PROJECT_ID, lastInteractedAt: `2026-01-0${8 - index}T00:00:00.000Z` })
      ) as never
    );
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-home-count'] },
      ])
    );
    store.setStateGroupsEnabled(true);
    // Positive control: the idle cap really folds some families away.
    expect(store.standaloneMore?.hiddenCount).toBe(2);
    expect(store.standaloneRootCount).toBe(7);

    store.toggleIdleExpanded(store.standaloneMore!.foldKey);
    expect(store.standaloneMore?.expanded).toBe(true);
    expect(store.standaloneRootCount).toBe(7);

    store.toggleSessionsCollapsed();
    expect(store.standaloneRootCount).toBe(7);

    sessionRegistry.release('task-home-count');
  });


});

// #6264 behavior gugu-server「会话页里的别的机器」(owner 2026-09-25 选 A):别的机器上的会话一律属于那台机器上的
// 某个项目;没选项目的挂在那台机器的主目录项目「~」下(读取时归属);「任务」列表只放本机没有项目的会话。
describe('SidebarStore: 别的机器上的会话归到那台机器的项目下', () => {
  const REMOTE_SESSION_HOME = `${IMPLICIT_SESSION_HOME_PROJECT_ID}~d22`;
  /** d22 上的会话:来自会话目录(列出不挂载),❌ 来自挂载的项目。 */
  const listed = new Map<string, SessionpageSessionSummary>();
  const machineOf = (id: string) => (id === REMOTE_SESSION_HOME || id.startsWith('d22-') ? 'd22' : null);
  const machines = {
    machineOf,
    label: () => 'd22',
    homeDir: () => '/root',
    sessionsOf: () => ({ sessions: [...listed.values()], live: true }),
  };
  beforeEach(() => listed.clear());

  function managerWithPaths(
    projects: { id: string; path: string; sessionIds: string[]; name?: string; kind?: 'workspace' }[]
  ): SidebarProjectManager {
    return {
      projects: new Map(
        projects.map((project) => [
          project.id,
          {
            id: project.id,
            name: project.name ?? null,
            createdAt: '2026-01-01T00:00:00.000Z',
            data: { path: project.path, kind: project.kind },
            mountedProject: {
              sessionManager: {
                sessions: new Map(
                  project.sessionIds.map((sessionId) => [
                    sessionId,
                    sessionFixture(sessionId, '2026-01-01T00:00:00.000Z'),
                  ])
                ),
              },
            },
          },
        ])
      ),
    } as unknown as SidebarProjectManager;
  }

  function acquire(sessionId: string, projectId: string, rowSessionId: string, parentSessionId?: string) {
    if (machineOf(projectId)) {
      listed.set(rowSessionId, {
        conversationId: rowSessionId,
        projectId,
        title: rowSessionId,
        harness: 'codex',
        runtime: 'acp',
        agentStatus: null,
        lastInteractedAt: '2026-01-02T00:00:00.000Z',
        supported: true,
        parentConversationId: parentSessionId ?? null,
      });
    }
    sessionRegistry.acquire(sessionId, projectId, [
      {
        id: rowSessionId,
        projectId,
        providerId: 'codex',
        title: rowSessionId,
        lastInteractedAt: '2026-01-02T00:00:00.000Z',
        type: 'acp',
        parentSessionId,
      },
    ] as never);
  }

  it('#609 那台机器的任务工作区、迁成 workspace 的主目录项目都不单列,会话与本机的一起平铺在「任务」里', () => {
    acquire('rt-old', REMOTE_SESSION_HOME, 'rc-old');
    acquire('rt-home', 'd22-home', 'rc-home');
    acquire('lt-mine', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-mine');
    const store = new SidebarStore(
      managerWithPaths([
        { id: 'd22-home', path: '/root', sessionIds: ['rt-home'], kind: 'workspace' },
        { id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-old'] },
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/me/task-home', sessionIds: ['lt-mine'] },
      ])
    );
    store.machines = machines;
    store.expandAllProjects();

    expect(store.orderedProjects).toEqual([]);
    expect(store.standaloneSessionEntries.map((e) => e.sessionId).sort()).toEqual(['lc-mine', 'rc-home', 'rc-old']);
    expect(store.rowOfSession(REMOTE_SESSION_HOME, 'rc-old')).toBeNull();
    expect(store.rowOfSession('d22-home', 'rc-home')).toBeNull();
    expect(store.projectLabel(REMOTE_SESSION_HOME)).toBeNull();
    // 对照:没迁过的老 server 上,主目录项目还是 kind=project —— 就是一个普通项目行(❌「~」)。
    const legacy = new SidebarStore(managerWithPaths([{ id: 'd22-home', path: '/root', sessionIds: ['rt-home'], name: 'root' }]));
    legacy.machines = machines;
    expect(legacy.orderedProjects.map((p) => p.id)).toEqual(['d22-home']);
    expect(legacy.projectLabel('d22-home')).toBe('root');
    for (const id of ['rt-old', 'rt-home', 'lt-mine']) sessionRegistry.release(id);
  });

  // #7341 第二步:同一个项目在本机与 d22 上各有一个本地项目,绑在同一个项目群上 ⇒ 侧栏合成一行。
  it('绑在同一个项目群上的本机项目与 d22 上的项目合成一行,d22 那边的会话挂在这一行下', () => {
    acquire('lt-g', 'local-gugu', 'lc-g');
    acquire('rt-g', 'd22-gugu', 'rc-g');
    const manager = () =>
      managerWithPaths([
        { id: 'local-gugu', path: '/Users/me/gugu', sessionIds: ['lt-g'], name: 'gugu' },
        { id: 'd22-gugu', path: '/www/gugu', sessionIds: ['rt-g'], name: 'gugu' },
      ]);
    const store = new SidebarStore(manager());
    store.machines = { ...machines, projectGroupOf: (id: string) => (id.endsWith('-gugu') ? 'chat-gugu' : undefined) };
    store.expandAllProjects();

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['local-gugu']);
    expect(store.rowProjectIdOf('d22-gugu')).toBe('local-gugu');
    expect(store.projectMembersOf('local-gugu')).toEqual(['local-gugu', 'd22-gugu']);
    expect(store.extraMachinesOf('local-gugu')).toEqual(['d22']);
    // 两台上同名的同一个项目并成了一行:不再算「另有同名的一行」,❌ 这一行挂上路径(实机撞过)。
    expect(store.hasNameTwin('local-gugu')).toBe(false);
    const conversations = store.sidebarRows.flatMap((row) => (row.kind === 'conversation' ? [row.sessionId] : []));
    expect(conversations.sort()).toEqual(['lc-g', 'rc-g']);

    // 对照:不知道绑定(或没绑)时,两台上的各是一行。
    const separate = new SidebarStore(manager());
    separate.machines = machines;
    expect(separate.orderedProjects.map((p) => p.id).sort()).toEqual(['d22-gugu', 'local-gugu']);
    expect(separate.extraMachinesOf('local-gugu')).toEqual([]);
    expect(separate.hasNameTwin('local-gugu')).toBe(true);
    sessionRegistry.release('lt-g');
    sessionRegistry.release('rt-g');
  });

  it('#7199 个人助理自己的会话不进任务区;它派的照常在、成了根,并认得出是它派的', () => {
    acquire('rt-asst', REMOTE_SESSION_HOME, 'rc-asst');
    acquire('rt-kid', REMOTE_SESSION_HOME, 'rc-kid', 'rc-asst');
    acquire('rt-other', REMOTE_SESSION_HOME, 'rc-other');
    listed.set('rc-asst', { ...listed.get('rc-asst')!, agent: { userId: 'u-asst' } });
    listed.set('rc-kid', { ...listed.get('rc-kid')!, agent: { userId: 'u-kid' } });
    const store = new SidebarStore(
      managerWithPaths([{ id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-asst', 'rt-kid', 'rt-other'] }])
    );
    store.machines = machines;
    store.expandedSessionIds.add('rc-asst');
    const shown = () => store.standaloneSessionEntries.map((entry) => `${entry.sessionId}@${entry.depth}`);

    // 对照:还不知道助理是谁时,它那条在、子 agent 挂在它下面。
    expect(shown()).toEqual(['rc-asst@0', 'rc-kid@1', 'rc-other@0']);
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-kid')).toBe(false);

    store.setAssistantAgentId('u-asst');
    expect(shown()).toEqual(['rc-kid@0', 'rc-other@0']);
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-kid')).toBe(true);
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-other')).toBe(false);
    // 认的是 agent 身份:换成别人的 id,它那条就回来。
    store.setAssistantAgentId('u-kid');
    expect(shown()).toEqual(['rc-asst@0', 'rc-other@0']);
    for (const id of ['rt-asst', 'rt-kid', 'rt-other']) sessionRegistry.release(id);
  });

  // owner 2026-10-01:别的机器上的 agent 也挂在本机的 agent 下面(反过来也一样),会话列表按「谁派的谁」成组,
  // 行首的机器标记由 parentProjectId 判(父会话与它不在同一台机器上才画)。
  it('跨机器的 child 跟着父会话那一行走,❌ 留在自己机器的项目下', () => {
    acquire('lt-parent', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-parent');
    acquire('rt-child', 'd22-app', 'rc-child', 'lc-parent');
    acquire('rt-root', 'd22-app', 'rc-root');
    acquire('lt-kid', 'local-proj', 'lc-kid', 'rc-root');
    const store = new SidebarStore(
      managerWithPaths([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/me/task-home', sessionIds: ['lt-parent'] },
        { id: 'd22-app', path: '/root/app', sessionIds: ['rt-child', 'rt-root'] },
        { id: 'local-proj', path: '/me/proj', sessionIds: ['lt-kid'] },
      ])
    );
    store.machines = machines;
    store.expandAllProjects();
    store.toggleSessionExpanded('lc-parent');
    store.toggleSessionExpanded('rc-root');

    // 本机「任务」分区里的父会话下面挂着 d22 上的 child。
    expect(store.standaloneSessionEntries).toEqual([
      expect.objectContaining({ sessionId: 'lc-parent', depth: 0, parentProjectId: undefined }),
      expect.objectContaining({ sessionId: 'rc-child', depth: 1, parentProjectId: IMPLICIT_SESSION_HOME_PROJECT_ID }),
    ]);
    // d22 的项目下:它自己的根会话,下面挂着本机的 child;d22 上那个 child 不在这里重复出现,本机项目下也没有行。
    const sessions = store.sidebarRows.filter((row) => row.kind === 'conversation');
    expect(sessions).toEqual([
      expect.objectContaining({ sessionId: 'rc-root', depth: 0, parentProjectId: undefined }),
      expect.objectContaining({ sessionId: 'lc-kid', projectId: 'local-proj', depth: 1, parentProjectId: 'd22-app' }),
    ]);
    // 键盘 ← 与打开任务时展开的都是它显示在下面的那一行。
    expect(store.rowOfSession('d22-app', 'rc-child')).toBeNull();
    expect(store.rowOfSession('local-proj', 'lt-kid')).toBe('d22-app');
    for (const sessionId of ['lt-parent', 'rt-child', 'rt-root', 'lt-kid']) sessionRegistry.release(sessionId);
  });

  // owner 2026-10-02:本机选了 nest 的 child 也可以在别的项目里 —— 与跨机器同一条:跟着父会话那一行走,行上标它的项目。
  it('本机别的项目里的 child 跟着父会话那一行走,与父会话不在同一个项目行就标项目', () => {
    acquire('pa', 'proj-a', 'c-parent');
    acquire('pb', 'proj-b', 'c-child', 'c-parent');
    acquire('pa2', 'proj-a', 'c-sibling', 'c-parent');
    acquire('rt-home', REMOTE_SESSION_HOME, 'rc-home', 'c-parent');
    const store = new SidebarStore(
      managerWithPaths([
        { id: 'proj-a', path: '/me/a', sessionIds: ['pa', 'pa2'], name: 'Alpha' },
        { id: 'proj-b', path: '/me/b', sessionIds: ['pb'], name: 'Beta' },
        { id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-home'] },
      ])
    );
    store.machines = machines;
    store.expandAllProjects();
    store.toggleSessionExpanded('c-parent');

    const sessions = store.sidebarRows.filter((row) => row.kind === 'conversation');
    expect(sessions.map((row) => row.kind === 'conversation' && [row.sessionId, row.depth])).toEqual(
      expect.arrayContaining([['c-parent', 0], ['c-child', 1], ['c-sibling', 1], ['rc-home', 1]])
    );
    expect(sessions).toHaveLength(4);
    expect(store.rowOfSession('proj-b', 'pb')).toBe('proj-a');
    expect(store.nestedProjectLabel('proj-b', 'proj-a')).toBe('Beta');
    expect(store.nestedProjectLabel('proj-a', 'proj-a')).toBeNull();
    // #609 别的机器、没选项目(那台机器的任务工作区):不是项目,只标机器、❌ 标项目名。
    expect(store.nestedProjectLabel(REMOTE_SESSION_HOME, 'proj-a')).toBeNull();
    // 机器标记悬停里写的项目名:不论跟父会话比,都是它自己那一行的名字。
    expect(store.projectLabel('proj-a')).toBe('Alpha');
    expect(store.projectLabel(REMOTE_SESSION_HOME)).toBeNull();
    for (const sessionId of ['pa', 'pb', 'pa2', 'rt-home']) sessionRegistry.release(sessionId);
  });

  it('那台机器上别处建的 standalone 任务(手机 / 远端建 agent)挂在它自己的项目下', () => {
    acquire('rt-app', 'd22-app', 'rc-app');
    const store = new SidebarStore(
      managerWithPaths([{ id: 'd22-app', path: '/root/app', sessionIds: ['rt-app'] }])
    );
    store.machines = machines;
    store.expandAllProjects();

    expect(store.sidebarRows.some((row) => row.kind === 'conversation' && row.sessionId === 'rc-app')).toBe(true);
    expect(store.standaloneSessionEntries).toEqual([]);
    sessionRegistry.release('rt-app');
  });

  it('列出不挂载:没挂上的那台机器的项目照样列出会话目录里的会话(打开就先画上次的样子)', () => {
    acquire('rt-listed', 'd22-app', 'rc-listed');
    sessionRegistry.release('rt-listed');
    const store = new SidebarStore({
      projects: new Map([
        ['d22-app', { id: 'd22-app', name: 'app', createdAt: '2026-01-01T00:00:00.000Z', data: { path: '/root/app' }, mountedProject: undefined }],
      ]),
    } as unknown as SidebarProjectManager);
    store.machines = machines;
    store.expandAllProjects();
    expect(store.sidebarRows.filter((row) => row.kind === 'conversation')).toEqual([
      expect.objectContaining({ sessionId: 'rc-listed', projectId: 'd22-app' }),
    ]);
    expect(store.remoteSession('d22-app', 'rc-listed')).toMatchObject({ summary: { conversationId: 'rc-listed' }, live: true });
    expect(store.remoteSession('d22-app', 'nope')).toBeNull();
    expect(store.remoteSession('local-proj', 'rc-listed')).toBeNull();
  });

  it('不是此刻的读数(底稿 / 离线):行上「在跑」不算数;在等你照报;置顶的进置顶分区', () => {
    for (const id of ['busy', 'ask', 'pin']) {
      acquire(`rt-${id}`, 'd22-app', `rc-${id}`);
      sessionRegistry.release(`rt-${id}`);
    }
    listed.set('rc-busy', { ...listed.get('rc-busy')!, status: { status: 'working', detail: null } });
    listed.set('rc-ask', { ...listed.get('rc-ask')!, status: { status: 'needs_user', detail: null } });
    listed.set('rc-pin', { ...listed.get('rc-pin')!, isPinned: true });
    let live = true;
    const store = new SidebarStore(managerWithPaths([{ id: 'd22-app', path: '/root/app', sessionIds: [] }]));
    store.machines = { ...machines, sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    store.expandAllProjects();
    store.setStateGroupsEnabled(true);
    const groups = () =>
      Object.fromEntries(
        store.sidebarRows.flatMap((row) => (row.kind === 'state-header' ? [[row.group, row.count]] : []))
      );
    expect(groups()).toEqual({ 'needs-you': 1, working: 1 });
    expect(store.pinnedSessionEntries.map((e) => e.sessionId)).toEqual(['rc-pin']);
    runInAction(() => (live = false));
    store.machines = { ...machines, sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    expect(groups()).toEqual({ 'needs-you': 1 });
  });

  it('本机不变:本机没项目的会话仍在「任务」列表,本机任务工作区不进「项目」', () => {
    acquire('lt-home', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-home');
    const store = new SidebarStore(
      managerWithPaths([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/Users/me/task-home', sessionIds: ['lt-home'] },
        { id: 'mine', path: '/Users/me', sessionIds: [] },
      ])
    );
    store.machines = machines;
    store.expandAllProjects();

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['mine']);
    expect(store.homeLayout.homeRows.size).toBe(0);
    expect(store.standaloneSessionEntries.map((e) => e.sessionId)).toEqual(['lc-home']);
    sessionRegistry.release('lt-home');
  });
});

// 用户折叠的项目 / 分区只在导航到另一项任务时才会被打开;置顶会话不算,分区折叠跨重启保留。
describe('SidebarStore keeps what the user folded folded', () => {
  function session(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      projectId: 'project-a',
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
      runtime: 'acp',
      ...extra,
    };
  }

  function twoProjects() {
    return new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-a', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-a1', 'task-a2'] },
        { id: 'project-b', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['task-b1'] },
      ])
    );
  }

  it('opens the project of a task it arrives at, once per arrival', () => {
    const store = twoProjects();
    store.revealActiveSession({ projectId: 'project-a', sessionId: 'task-a1' });
    expect(store.expandedProjectIds.has('project-a')).toBe(true);

    // The user folds it while staying on that task; a repeated report of the same task is no arrival.
    store.toggleProjectExpanded('project-a');
    store.revealActiveSession({ projectId: 'project-a', sessionId: 'task-a1' });
    expect(store.expandedProjectIds.has('project-a')).toBe(false);

    // Going somewhere else and coming back is an arrival again.
    store.revealActiveSession(null);
    store.revealActiveSession({ projectId: 'project-a', sessionId: 'task-a1' });
    expect(store.expandedProjectIds.has('project-a')).toBe(true);
  });

  it('does not open a project for a task whose session sits in Pinned', () => {
    sessionRegistry.acquire('task-a1', 'project-a', [
      session('pinned-a1', { isPinned: true }),
    ] as never);
    sessionRegistry.acquire('task-a2', 'project-a', [session('plain-a2')] as never);
    const store = twoProjects();
    store.revealActiveSession({ projectId: 'project-a', sessionId: 'task-a1' });
    expect(store.expandedProjectIds.has('project-a')).toBe(false);

    // Control: an unpinned session of the same project does open it.
    store.revealActiveSession({ projectId: 'project-a', sessionId: 'task-a2' });
    expect(store.expandedProjectIds.has('project-a')).toBe(true);

    sessionRegistry.release('task-a1');
    sessionRegistry.release('task-a2');
  });

  it('persists folded section headers across a restart', () => {
    const source = twoProjects();
    source.togglePinnedCollapsed();
    source.toggleProjectsCollapsed();
    source.toggleSessionsCollapsed();
    source.toggleChatsCollapsed();

    const restored = twoProjects();
    restored.restoreSnapshot(source.snapshot);
    expect([restored.pinnedCollapsed, restored.projectsCollapsed, restored.sessionsCollapsed, restored.chatsCollapsed]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    // A blob written before these fields existed leaves the sections open.
    const legacy = twoProjects();
    legacy.restoreSnapshot({ expandedProjectIds: [] });
    expect([legacy.pinnedCollapsed, legacy.projectsCollapsed, legacy.sessionsCollapsed, legacy.chatsCollapsed]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps the sidebar layout and the open tab across a restart (gugu-dev#181)', () => {
    const source = twoProjects();
    source.setListLayout('merged');
    source.setListPage('chats');

    const restored = twoProjects();
    restored.restoreSnapshot(source.snapshot);
    expect([restored.listLayout, restored.listPage]).toEqual(['merged', 'chats']);

    // Older blobs (and unknown values) land on the default: Projects and Chats as two tabs, Projects open.
    const legacy = twoProjects();
    legacy.restoreSnapshot({ expandedProjectIds: [] });
    expect([legacy.listLayout, legacy.listPage]).toEqual(['split', 'projects']);
  });
});

describe('拼在一屏的几条:左边合成一个框(spec session-page「拼在一屏的几块是一组」,#7097)', () => {
  const HOME = IMPLICIT_SESSION_HOME_PROJECT_ID;
  const group = (sessionIds: string[], onScreen: boolean) => ({ members: sessionIds.map(blockKey.session), onScreen });
  const conv = (id: string, projectId: string, second: number) => ({
    id,
    projectId,
    providerId: 'codex',
    title: id,
    lastInteractedAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
    runtime: 'acp' as const,
    agentStatus: null,
  });

  // 项目 project-1 下一条 p1;任务区 t1..t(n),越往后越旧。
  function setup(taskCount = 4) {
    sessionRegistry.acquire('page-p1', 'project-1', [conv('p1', 'project-1', 50)]);
    const pages: string[] = [];
    for (let i = 1; i <= taskCount; i += 1) {
      sessionRegistry.acquire(`page-t${i}`, HOME, [conv(`t${i}`, HOME, 40 - i)]);
      pages.push(`page-t${i}`);
    }
    const store = new SidebarStore(
      projectManagerWithSessions([
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['page-p1'] },
        { id: HOME, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: pages },
      ])
    );
    store.expandAllProjects();
    const release = () => {
      sessionRegistry.release('page-p1');
      for (const page of pages) sessionRegistry.release(page);
    };
    return { store, release };
  }
  const projectConversations = (store: SidebarStore) =>
    store.sidebarRows.flatMap((row) => (row.kind === 'conversation' ? [row.sessionId] : []));
  const tasks = (store: SidebarStore) => store.standaloneSessionEntries.map((e) => `${e.sessionId}${e.join ? `:${e.join.pos}` : ''}`);

  it('组员从原位置挪进最靠前那一条那里(别的项目的也挪过来),按屏上次序叠着;每行记着自己是框的哪一段', () => {
    const { store, release } = setup();
    expect(tasks(store)).toEqual(['t1', 't2', 't3', 't4']);
    expect(projectConversations(store)).toEqual(['p1']);

    // project-1 排在独立任务区前面:p1 最靠前,框在 project-1 下面
    store.setJoinedGroups([group(['t3', 'p1', 't1'], true)]);
    expect(projectConversations(store)).toEqual(['t3', 'p1', 't1']);
    expect(tasks(store)).toEqual(['t2', 't4']);
    expect(store.sidebarRows.filter((row) => row.kind === 'conversation').find((e) => e.sessionId === 'p1')?.join).toEqual({ pos: 'middle', onScreen: true });
    // 键盘上下走的次序与画出来的一致
    expect(
      store.navChain.flatMap((node) => (node.kind === 'conversation' ? [node.sessionId] : []))
    ).toEqual(['t3', 'p1', 't1', 't2', 't4']);
    release();
  });

  it('不在屏上的组照样是框(只剩细框)', () => {
    const { store, release } = setup();
    store.setJoinedGroups([group(['t2', 't4'], false)]);
    expect(store.standaloneSessionEntries.map((e) => [e.sessionId, e.join?.onScreen])).toEqual([
      ['t1', undefined],
      ['t2', false],
      ['t4', false],
      ['t3', undefined],
    ]);
    release();
  });

  // 任务区:P(有子会话 C)、t1、t2、t3,越往后越旧。
  function setupFamily() {
    sessionRegistry.acquire('page-P', HOME, [conv('P', HOME, 30)]);
    sessionRegistry.acquire('page-C', HOME, [{ ...conv('C', HOME, 29), parentSessionId: 'P' }]);
    for (const [i, id] of ['t1', 't2', 't3'].entries()) sessionRegistry.acquire(`page-${id}`, HOME, [conv(id, HOME, 20 - i)]);
    const pages = ['page-P', 'page-C', 'page-t1', 'page-t2', 'page-t3'];
    const store = new SidebarStore(
      projectManagerWithSessions([{ id: HOME, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: pages }])
    );
    store.toggleSessionExpanded('P');
    return { store, release: () => pages.forEach((page) => sessionRegistry.release(page)) };
  }
  const tasksWithDepth = (store: SidebarStore) =>
    store.standaloneSessionEntries.map((e) => `${e.sessionId}@${e.depth ?? 0}${e.join ? `:${e.join.pos}` : ''}`);

  it('组员是父子:框在父会话那里,子会话挪进框;父会话收着照样成框(子会话在框里看得见)', () => {
    const { store, release } = setupFamily();
    expect(tasksWithDepth(store)).toEqual(['P@0', 'C@1', 't1@0', 't2@0', 't3@0']);
    store.setJoinedGroups([group(['C', 'P'], true)]);
    expect(tasksWithDepth(store)).toEqual(['C@0:first', 'P@0:last', 't1@0', 't2@0', 't3@0']);
    store.toggleSessionExpanded('P');
    expect(tasksWithDepth(store)).toEqual(['C@0:first', 'P@0:last', 't1@0', 't2@0', 't3@0']);
    release();
  });

  it('两个组员是父子:各占框里一行,❌ 子会话跟着父会话再出现一次', () => {
    const { store, release } = setupFamily();
    store.setJoinedGroups([group(['t3', 'P', 'C'], false)]);
    expect(tasksWithDepth(store)).toEqual(['t3@0:first', 'P@0:middle', 'C@0:last', 't1@0', 't2@0']);
    release();
  });

  it('两组的框各在父子两条那里:各成各的框,里层那组排在外层框的后面', () => {
    const { store, release } = setupFamily();
    store.setJoinedGroups([
      group(['C', 't2'], false),
      group(['P', 't1'], true),
    ]);
    expect(tasksWithDepth(store)).toEqual(['P@0:first', 't1@0:last', 'C@1:first', 't2@1:last', 't3@0']);
    release();
  });

  it('最靠前那一条在收起的项目里:框挪到看得见的组员里最靠前那条', () => {
    const { store, release } = setup();
    store.setJoinedGroups([group(['p1', 't1'], false)]);
    expect(tasks(store)).toEqual(['t2', 't3', 't4']);
    store.toggleProjectExpanded('project-1');
    expect(tasks(store)).toEqual(['p1:first', 't1:last', 't2', 't3', 't4']);
    release();
  });

  it('groups independent tasks while ignoring chats and Apps in the same screen group', () => {
    const { store, release } = setup();
    store.setJoinedGroups([{ members: ['chat:c1', 'session:t3', 'session:t1', 'app:x.clock'], onScreen: true }]);
    expect(tasks(store)).toEqual(['t3:first', 't1:last', 't2', 't4']);
    store.setJoinedGroups([{ members: ['session:t2', 'app:x.clock'], onScreen: false }]);
    expect(tasks(store)).toEqual(['t1', 't2', 't3', 't4']);
    release();
  });

  it('框在的那一家不收进「展开显示」;收在「展开显示」后面的组员挪进框里', () => {
    const { store, release } = setup(8);
    expect(tasks(store)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    store.setJoinedGroups([group(['t8', 't2'], true)]);
    expect(tasks(store)).toEqual(['t1', 't8:first', 't2:last', 't3', 't4', 't5', 't6']);
    release();
  });
});
