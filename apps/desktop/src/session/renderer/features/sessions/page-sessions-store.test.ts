import { autorun } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { PageSessionsStore } from './page-sessions-store';

const hydrateSession = vi.hoisted(() => vi.fn());
const dehydrateSession = vi.hoisted(() => vi.fn());
const frontendConnect = vi.hoisted(() => vi.fn());
const frontendDispose = vi.hoisted(() => vi.fn());

vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({
  makeFileLinkHandlers: () => ({
    onOpenExternal: vi.fn(),
    onOpenFile: vi.fn(),
  }),
}));

const archiveSession = vi.hoisted(() => vi.fn());
/** 记下每个频道的 handler —— 不记就测不到「事件到达之后发生了什么」。 */
const eventHandlers = vi.hoisted(() => new Map<unknown, ((payload: unknown) => void)[]>());

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (channel: unknown, handler: (payload: unknown) => void) => {
      const list = eventHandlers.get(channel) ?? [];
      list.push(handler);
      eventHandlers.set(channel, list);
      return () => {};
    },
  },
  rpc: {
    sessions: {
      archiveSession,
      dehydrateSession,
      getUnarchivedSession: vi.fn(),
      hydrateSession,
      markSessionSeen: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@renderer/lib/pty/pty', () => ({
  loadXterm: async () => {},
  FrontendPty: class {
    constructor(readonly ptySessionId: string) {}

    connect = frontendConnect;
    dispose = frontendDispose;
  },
}));

describe('PageSessionsStore session hydration', () => {
  beforeEach(() => {
    hydrateSession.mockReset();
    dehydrateSession.mockReset();
    frontendConnect.mockReset();
    frontendDispose.mockReset();

    hydrateSession.mockResolvedValue(undefined);
    dehydrateSession.mockResolvedValue(undefined);
    frontendConnect.mockResolvedValue(undefined);
  });

  it('does not hydrate conversations from the PTY session connect path', async () => {
    const store = new PageSessionsStore('project-1', 'session-1', [
      {
        id: 'conversation-1',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
      },
    ]);

    const session = store.ptySessions.get('conversation-1');
    expect(session).toBeDefined();

    await session?.connect();

    expect(hydrateSession).not.toHaveBeenCalled();
    expect(frontendConnect).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it('关掉再打开:dehydrate 拆掉的终端,在 hydrate 落定后重新接上(别处一直读着 status 也一样)', async () => {
    const store = new PageSessionsStore('project-1', 'session-1', [
      {
        id: 'conversation-1',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
      },
    ]);
    const session = store.ptySessions.get('conversation-1')!;
    // 一个从不撒手的读者(实测是三个 observer 组件):status 从此一直「被观察着」,懒连接只在第一次触发。
    const stopWatching = autorun(() => void session.status);
    await vi.waitFor(() => expect(session.status).toBe('ready'));

    await store.dehydrateSession('conversation-1');
    expect(session.status).toBe('disconnected');

    await store.hydrateSession('conversation-1');
    await vi.waitFor(() => expect(session.status).toBe('ready'));
    expect(frontendConnect).toHaveBeenCalledTimes(2);

    stopWatching();
    store.dispose();
  });
});

describe('PageSessionsStore four-state status projection', () => {
  const makeStore = () =>
    new PageSessionsStore('project-1', 'session-1', [
      {
        id: 'c1',
        projectId: 'project-1',
        providerId: 'codex',
        title: 'Conversation 1',
        lastInteractedAt: null,
      },
    ]);

  it('projects permission approval and idle completion', () => {
    const store = makeStore();
    const conv = store.sessions.get('c1');
    expect(conv).toBeDefined();

    // The host wrote a tool-permission wait → the amber "approve me" state.
    conv!.applyStatus({ reading: { status: 'needs_user', detail: 'approval' }, unseen: true, statusSourceFault: null });
    expect(conv!.indicatorStatus).toBe('needs_user');
    expect(store.sessionStatus).toBe('needs_user');

    conv!.applyStatus({ reading: { status: 'idle', detail: 'plain' }, unseen: false, statusSourceFault: null });
    expect(conv!.indicatorStatus).toBeNull();
    expect(store.sessionStatus).toBeNull();

    store.dispose();
  });

  it('needs_user outranks idle in the task rollup', () => {
    const store = new PageSessionsStore('project-1', 'session-1', [
      { id: 'c1', projectId: 'project-1', providerId: 'codex', title: 'A', lastInteractedAt: null },
      { id: 'c2', projectId: 'project-1', providerId: 'codex', title: 'B', lastInteractedAt: null },
    ]);
    store.sessions.get('c1')!.applyStatus({ reading: { status: 'idle', detail: 'plain' }, unseen: false, statusSourceFault: null });
    store.sessions.get('c2')!.applyStatus({ reading: { status: 'needs_user', detail: 'approval' }, unseen: true, statusSourceFault: null });
    expect(store.sessionStatus).toBe('needs_user');
    store.dispose();
  });

  it('suppresses the indicator once the conversation is seen (you are already looking at it)', () => {
    const store = makeStore();
    const conv = store.sessions.get('c1');
    conv!.applyStatus({ reading: { status: 'needs_user', detail: 'approval' }, unseen: true, statusSourceFault: null });
    expect(conv!.indicatorStatus).toBe('needs_user');
    // Viewing a conversation marks it seen → its own indicator is suppressed; the attention shifts to
    // whichever OTHER agent still needs you (this is why the otty demo shows a non-active agent's dot).
    conv!.markSeen();
    expect(conv!.indicatorStatus).toBeNull();
    expect(store.sessionStatus).toBeNull();
    store.dispose();
  });
});

/**
 * spec session-graph:归档 = 这一行离开会话列表(归属键是会话自己,#5413)。渲染侧要两半都对:
 * 自己发起的那次**乐观**收起(失败要放回去),以及**别处**发生的归档由事件收起。
 */
describe('PageSessionsStore 归档', () => {
  const row = (id: string, edges: Partial<{ parentSessionId: string; spawnedBySessionId: string }> = {}) => ({
    id,
    projectId: 'project-1',
    providerId: 'codex' as const,
    title: id,
    lastInteractedAt: null,
    ...edges,
  });

  beforeEach(() => {
    archiveSession.mockReset();
    // 主进程的合同:报回这一次真正收走的行(一条都没收就是空清单,❌ undefined)。
    archiveSession.mockResolvedValue({ archived: [], unreached: [] });
    eventHandlers.clear();
  });

  it('乐观收起被点名的那一行,别的行不动;把主进程报回的清单原样交出去', async () => {
    const store = new PageSessionsStore('project-1', 'a', [row('a')]);
    const reported = { archived: [{ projectId: 'project-1', sessionId: 'a' }], unreached: [] };
    archiveSession.mockResolvedValue(reported);

    const archived = await store.archiveSession('a');

    expect(archived).toBe(reported);
    expect(archiveSession).toHaveBeenCalledWith('project-1', 'a', {});
    expect(store.sessions.has('a')).toBe(false);
    store.dispose();
  });

  it('勾了范围就把挂在它下面的整棵子树一起收起;派出去没挂的、fork 都不在其中', async () => {
    const store = new PageSessionsStore('project-1', 'session-1', [
      row('parent'),
      row('child', { parentSessionId: 'parent', spawnedBySessionId: 'parent' }),
      row('standalone', { spawnedBySessionId: 'parent' }),
      row('bystander'),
    ]);

    await store.archiveSession('parent', { withChildren: true });

    expect(store.sessions.has('parent')).toBe(false);
    expect(store.sessions.has('child')).toBe(false);
    // owner 2026-10-08:派出去没挂的是给人用的,不跟着收。
    expect(store.sessions.has('standalone')).toBe(true);
    expect(store.sessions.has('bystander')).toBe(true);
    store.dispose();
  });

  it('归档失败就把行放回去 —— ❌ 让一次失败的归档看起来像成功', async () => {
    archiveSession.mockRejectedValue(new Error('nope'));
    const store = new PageSessionsStore('project-1', 'session-1', [row('a'), row('b')]);

    await expect(store.archiveSession('a')).rejects.toThrow('nope');

    expect(store.sessions.has('a')).toBe(true);
    store.dispose();
  });

  it('别处发生的归档:事件一到就收起这一行,❌ 只把字段抄进去等下一次 reload', () => {
    const store = new PageSessionsStore('project-1', 'a', [row('a')]);
    const handlers = eventHandlers.get(sessionChangedChannel) ?? [];
    expect(handlers.length).toBeGreaterThan(0); // 阳控:handler 真的注册了

    for (const handler of handlers) {
      handler({
        sessionId: 'a',
        projectId: 'project-1',
        changes: { archivedAt: '2026-09-11 01:00:00' },
      });
    }

    expect(store.sessions.has('a')).toBe(false);
    store.dispose();
  });

  it('别的字段变化不会把行收走(阴控:同一条 handler,只是 changes 不同)', () => {
    const store = new PageSessionsStore('project-1', 'a', [row('a')]);
    for (const handler of eventHandlers.get(sessionChangedChannel) ?? []) {
      handler({
        sessionId: 'a',
        projectId: 'project-1',
        changes: { title: 'renamed' },
      });
    }

    expect(store.sessions.has('a')).toBe(true);
    expect(store.sessions.get('a')?.data.title).toBe('renamed');
    store.dispose();
  });
});

describe('PageSessionsStore 引擎那边的状态清掉了 (#7223)', () => {
  const missingRow = {
    id: 'a',
    projectId: 'project-1',
    providerId: 'claude' as const,
    title: 'a',
    lastInteractedAt: null,
    providerSessionState: 'missing' as const,
  };

  beforeEach(() => {
    eventHandlers.clear();
  });

  // 网页宿主那条传输走 JSON:事件先过一遍 JSON 再交给 handler,才是那条宿主上真正收到的样子。
  const deliverOverJson = (changes: Record<string, unknown>) => {
    for (const handler of eventHandlers.get(sessionChangedChannel) ?? []) {
      handler(JSON.parse(JSON.stringify({ sessionId: 'a', projectId: 'project-1', changes })));
    }
  };

  it('`null` 过了 JSON 还在,页面不再顶着「已经没有这条会话了」', () => {
    const store = new PageSessionsStore('project-1', 'a', [missingRow]);
    expect(store.sessions.get('a')?.data.providerSessionState).toBe('missing');
    deliverOverJson({ providerSessionState: null, providerSessionId: 'fresh' });
    expect(store.sessions.get('a')?.data.providerSessionState).toBeUndefined();
    expect(store.sessions.get('a')?.data.providerSessionId).toBe('fresh');
    store.dispose();
  });

  it('阴控 —— 没说这一格:状态原样留着', () => {
    const store = new PageSessionsStore('project-1', 'a', [missingRow]);
    deliverOverJson({ title: 'renamed' });
    expect(store.sessions.get('a')?.data.providerSessionState).toBe('missing');
    store.dispose();
  });
});

describe('PageSessionsStore 上下文读数跟着记录走 (#7342)', () => {
  const reading = { used: 42_000, size: 200_000, modelId: 'gpt-5.5', providerSessionId: 'native-1' };
  const row = {
    id: 'a',
    projectId: 'project-1',
    providerId: 'codex' as const,
    title: 'a',
    lastInteractedAt: null,
    providerSessionId: 'native-1',
  };

  beforeEach(() => {
    eventHandlers.clear();
  });

  const deliverOverJson = (changes: Record<string, unknown>) => {
    for (const handler of eventHandlers.get(sessionChangedChannel) ?? []) {
      handler(JSON.parse(JSON.stringify({ sessionId: 'a', projectId: 'project-1', changes })));
    }
  };

  it('写下的读数进到渲染层那份记录;作废的 `null` 过了 JSON 还在,读数随之消失', () => {
    const store = new PageSessionsStore('project-1', 'a', [row]);
    deliverOverJson({ contextUsage: reading });
    expect(store.sessions.get('a')?.data.contextUsage).toEqual(reading);
    deliverOverJson({ contextUsage: null });
    expect(store.sessions.get('a')?.data.contextUsage).toBeUndefined();
    store.dispose();
  });

  it('阴控 —— 没说这一格:读数原样留着', () => {
    const store = new PageSessionsStore('project-1', 'a', [{ ...row, contextUsage: reading }]);
    deliverOverJson({ title: 'renamed' });
    expect(store.sessions.get('a')?.data.contextUsage).toEqual(reading);
    store.dispose();
  });
});
