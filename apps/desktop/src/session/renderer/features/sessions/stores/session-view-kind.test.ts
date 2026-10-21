import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPageStore } from './session-store';

const projects = new Map<string, unknown>();

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects }),
}));
// session-selectors 的 import 链会捎带真 AppState,它一构造就去 invoke electronAPI —— 在 node 里
// 那是两条没人接的 rejection,把「52 绿」的同一次 run 打成 Errors 2。替身让这条链停在门口。
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));

const { sessionViewKind } = await import('./session-selectors');

/** 一项挂好的项目;sessionViewKind 先看项目,项目没挂就一律是「项目还在开」。 */
function mountedProject() {
  return { state: 'mounted', mountedProject: {} };
}

function unprovisionedSession(options: { phase?: string; archivedAt?: string } = {}): SessionPageStore {
  return {
    state: 'unprovisioned',
    phase: options.phase ?? 'idle',
    data: { id: 't1', name: 'task', archivedAt: options.archivedAt },
  } as unknown as SessionPageStore;
}

beforeEach(() => {
  projects.clear();
  projects.set('p1', mountedProject());
});

describe('sessionViewKind 对归档任务', () => {
  // owner 2026-09-06 实机:归档掉当前打开的那条会话之后,右边永久停在「正在准备文件…」。归档后的
  // task 落在 unprovisioned 且没有在途阶段,而自动 provision 明确跳过归档任务(view.tsx)—— 判成
  // idle 就等于让「正在准备」这句话永远说下去。一个没人在准备的状态不该画成正在准备。
  it('判成 archived,❌ 混进 idle 变成永不结束的「正在准备」', () => {
    expect(sessionViewKind(unprovisionedSession({ archivedAt: '2026-09-06T00:00:00.000Z' }), 'p1')).toBe(
      'archived'
    );
  });

  it('没归档的空闲任务仍是 idle —— 那一档会被自动 provision 接走', () => {
    expect(sessionViewKind(unprovisionedSession(), 'p1')).toBe('idle');
  });

  // archiveSession 先乐观写下 archivedAt 再发 RPC,那一小段里 task 还挂着 workspace。判据若搬到函数
  // 开头,视图会当场闪一下「已归档」,归档失败回滚时再闪回来。
  it('在途阶段先说话:归档标记不该盖住 provisioning', () => {
    const archivedAt = '2026-09-06T00:00:00.000Z';
    expect(sessionViewKind(unprovisionedSession({ phase: 'provision', archivedAt }), 'p1')).toBe(
      'provisioning'
    );
  });
});

describe('sessionViewKind 对还没进列表的会话', () => {
  // 别的机器上的项目点开时才挂:openProject 回来项目就算挂上,会话列表还在读。那一小段里这条会话还没进
  // 列表,判成 missing 会先闪一下「找不到」,列表到了再跳回来(mac1 实测 130–350 ms)。
  it('列表还在读:仍是「项目还在开」', () => {
    projects.set('p1', { state: 'mounted', mountedProject: { sessionManager: { listState: 'reading' } } });
    expect(sessionViewKind(undefined, 'p1')).toBe('project-mounting');
  });

  it('列表读完了还没有:才是 missing', () => {
    projects.set('p1', { state: 'mounted', mountedProject: { sessionManager: { listState: 'read' } } });
    expect(sessionViewKind(undefined, 'p1')).toBe('missing');
  });
});
