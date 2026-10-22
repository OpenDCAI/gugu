import { describe, expect, it, vi } from 'vitest';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {},
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function sessionFixture(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: { id, isPinned: false, createdAt, updatedAt: createdAt },
  };
}

function projectManagerWith(projectId: string, sessionId: string): SidebarProjectManager {
  return {
    projects: new Map([
      [
        projectId,
        {
          id: projectId,
          createdAt: '2026-01-01T00:00:00.000Z',
          mountedProject: {
            sessionManager: {
              sessions: new Map([[sessionId, sessionFixture(sessionId, '2026-01-01T00:00:00.000Z')]]),
            },
          },
        },
      ],
    ]),
  } as unknown as SidebarProjectManager;
}

function session(
  id: string,
  projectId: string,
  agentStatus: string | null,
  minute: string
) {
  return {
    id,
    projectId,
    providerId: 'codex',
    title: id,
    lastInteractedAt: `2026-01-01T00:${minute}:00.000Z`,
    runtime: 'pty',
    agentStatus,
  };
}

// behavior session-page「会话列表与状态」: 二级分类(agent 状态分组)是一个可关的层。
// 关掉 = 不出组头,会话按最后交互时间平铺成一条列表。
describe('sidebar state groups toggle', () => {
  it('drops every state header and lists sessions newest-first when turned off', () => {
    sessionRegistry.acquire('task-g', 'project-g', [
      // 造成「分组顺序」与「时间顺序」不同,否则平铺是不是真按时间排就分辨不出来。
      session('needs-oldest', 'project-g', 'needs_user', '01'),
      session('working-newest', 'project-g', 'working', '05'),
      session('idle-middle', 'project-g', null, '03'),
    ] as never);
    const store = new SidebarStore(projectManagerWith('project-g', 'task-g'));
    store.ensureProjectExpanded('project-g');
    // 默认已是关(owner 2026-09-06),所以「开着」这一档要显式打开 —— 别再拿 store 的
    // 初始值当前提,那个值只是设置的镜像,跟着默认走。
    store.setStateGroupsEnabled(true);

    const headers = () => store.sidebarRows.filter((row) => row.kind === 'state-header').length;
    const ids = () =>
      store.sidebarRows
        .filter((row) => row.kind === 'conversation')
        .map((row) => row.sessionId);

    // 开着:分组顺序 —— 需要你 → 工作中 → (已完成) → idle 平铺。
    expect(headers()).toBe(2);
    expect(ids()).toEqual(['needs-oldest', 'working-newest', 'idle-middle']);

    store.setStateGroupsEnabled(false);

    // 关掉:一个组头都没有,顺序改成纯时间倒序。
    expect(headers()).toBe(0);
    expect(ids()).toEqual(['working-newest', 'idle-middle', 'needs-oldest']);

    store.setStateGroupsEnabled(true);
    expect(headers()).toBe(2);

    sessionRegistry.release('task-g');
  });

  it('folds idle families the same way whether grouping is on or off, never a session that needs you', () => {
    // 折法两档一样(foldIdleFamilies):只收多出来的闲置家族。需要你的会话哪怕最旧也露着 ——
    // 所以关掉分组后再折,也不会「按新旧把需要你的会话藏起来」。
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    sessionRegistry.acquire(
      'task-cap',
      'project-cap',
      ids.map((id, i) =>
        session(id, 'project-cap', id === 'c1' ? 'needs_user' : null, String(10 + i).padStart(2, '0'))
      ) as never
    );
    const store = new SidebarStore(projectManagerWith('project-cap', 'task-cap'));
    store.ensureProjectExpanded('project-cap');

    const shown = () =>
      store.sidebarRows.flatMap((row) => (row.kind === 'conversation' ? [row.sessionId] : []));
    const more = () => store.sidebarRows.flatMap((row) => (row.kind === 'more' ? [row.hiddenCount] : []));

    store.setStateGroupsEnabled(true);
    expect(shown()).toEqual(['c1', 'c7', 'c6', 'c5', 'c4', 'c3']);
    expect(more()).toEqual([1]);

    store.setStateGroupsEnabled(false);
    expect(shown()).toEqual(['c7', 'c6', 'c5', 'c4', 'c3', 'c1']);
    expect(more()).toEqual([1]);

    sessionRegistry.release('task-cap');
  });

  it('keeps the keyboard chain in step with what is rendered', () => {
    sessionRegistry.acquire('task-k', 'project-k', [
      session('k-needs', 'project-k', 'needs_user', '01'),
      session('k-working', 'project-k', 'working', '05'),
    ] as never);
    const store = new SidebarStore(projectManagerWith('project-k', 'task-k'));
    store.ensureProjectExpanded('project-k');
    store.setStateGroupsEnabled(true);

    const chain = () =>
      store.navChain.filter((n) => n.kind === 'conversation').map((n) => n.sessionId);

    expect(chain()).toEqual(['k-needs', 'k-working']);

    // 平铺后 ↑↓ 的次序必须跟着画面走,而不是停在分组次序上。
    store.setStateGroupsEnabled(false);
    expect(chain()).toEqual(['k-working', 'k-needs']);

    sessionRegistry.release('task-k');
  });
});
