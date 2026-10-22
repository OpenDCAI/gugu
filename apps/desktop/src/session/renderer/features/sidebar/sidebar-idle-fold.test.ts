import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    rowSessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({ AcpChatPanel: () => null }));

/**
 * 「展开显示」(foldIdleFamilies):单位是家族,不闲置的家族永远露着;项目行与「任务」分区同一条折法,
 * 二级分类开或关都折。
 */
const TASK = 'fold-task';
const PROJECT = 'fold-project';

function session(id: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectId: PROJECT,
    providerId: 'codex',
    title: id,
    lastInteractedAt: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    runtime: 'acp',
    ...extra,
  };
}

function storeWith(projectId: string, sessions: ReturnType<typeof session>[]): SidebarStore {
  sessionRegistry.acquire(TASK, projectId, sessions.map((s) => ({ ...s, projectId })) as never);
  return new SidebarStore({
    projects: new Map([
      [
        projectId,
        {
          id: projectId,
          createdAt: '2026-01-01T00:00:00.000Z',
          mountedProject: {
            sessionManager: {
              sessions: new Map([
                [TASK, { state: 'provisioned', data: { id: TASK, isPinned: false, createdAt: '2026-01-01T00:00:00.000Z' } }],
              ]),
            },
          },
        },
      ],
    ]),
  } as unknown as SidebarProjectManager);
}

/** 项目下画出来的行:会话行写 `id`(子行前面加缩进点),「展开显示」写 `more:N` / `less`。 */
function projectRows(store: SidebarStore): string[] {
  return store.sidebarRows.flatMap((row) => {
    if (row.kind === 'conversation') return ['.'.repeat(row.depth ?? 0) + row.sessionId];
    if (row.kind === 'more') return [row.expanded ? 'less' : `more:${row.hiddenCount}`];
    return [];
  });
}

/** 7 个闲置的根,最新的那个带 3 个孩子(都闲置)。 */
const SEVEN_IDLE_ROOTS = [
  session('r1', 50),
  session('k1', 49, { parentSessionId: 'r1' }),
  session('k2', 48, { parentSessionId: 'r1' }),
  session('k3', 47, { parentSessionId: 'r1' }),
  session('r2', 40),
  session('r3', 39),
  session('r4', 38),
  session('r5', 37),
  session('r6', 36),
  session('r7', 35),
];

afterEach(() => sessionRegistry.release(TASK));

describe('项目行的「展开显示」', () => {
  for (const grouped of [false, true]) {
    it(`按家族折,展开的家族整家露着,「还有 N 个」数家族(二级分类${grouped ? '开' : '关'})`, () => {
      const store = storeWith(PROJECT, SEVEN_IDLE_ROOTS);
      store.setStateGroupsEnabled(grouped);
      store.ensureProjectExpanded(PROJECT);
      store.toggleSessionExpanded('r1');

      expect(projectRows(store)).toEqual(['r1', '.k1', '.k2', '.k3', 'r2', 'r3', 'r4', 'r5', 'more:2']);

      store.toggleIdleExpanded(PROJECT);
      expect(projectRows(store)).toEqual(['r1', '.k1', '.k2', '.k3', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'less']);
    });
  }

  it('孩子在跑的家族不闲置:排在上限外也露着,不占闲置名额', () => {
    const store = storeWith(PROJECT, [
      ...SEVEN_IDLE_ROOTS,
      session('busy-root', 30),
      session('busy-kid', 29, { parentSessionId: 'busy-root', agentStatus: 'working' }),
    ]);
    store.ensureProjectExpanded(PROJECT);

    expect(projectRows(store)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'busy-root', 'more:2']);
  });

  it('搜索时不折', () => {
    const store = storeWith(PROJECT, SEVEN_IDLE_ROOTS);
    store.ensureProjectExpanded(PROJECT);
    store.setSearchQuery('r');

    expect(projectRows(store).filter((row) => row.startsWith('more'))).toEqual([]);
    expect(projectRows(store)).toHaveLength(7);
  });
});

