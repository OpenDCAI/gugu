// @vitest-environment jsdom
/**
 * #6582 —— 面板后台命令花名册的筛子:运行时说「本进程里还在跑」的任务 id。
 *
 * 命令还在跑时重启 app(或 worker 重启、空闲回收),进程没了,命令随之没了,终态永远不会来;
 * 库里那张卡一直带着 `backgroundTaskId`、没有 `backgroundTaskDone`,面板于是永远「在跑」。
 * 哪些真活着只有运行时知道(`sessionState.backgroundCommandTaskIds`),store 把它变成可观察的
 * `runningBackgroundTaskIds` 交给花名册。
 *
 * 判据能判假吗:把 `_subscribeLiveSession` 里两处 `_syncRuntimeBackgroundTaskIds` 删掉,
 * 第一条用例红(停在初值 `[]`);把 `runningBackgroundTaskIds` 里缺席当 `[]`,第二条红。
 */
import { describe, expect, it, vi } from 'vitest';
import { autorun, runInAction } from 'mobx';
import { collectBackgroundCommandRoster } from '@gugu/session-chat-ui';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ getStoredQueue: vi.fn().mockResolvedValue([]), queuePrompt: vi.fn() }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
// 这个 project 里 `solid-js` 解析成服务端版(没有响应式),看不到画面上那一刻;改为记下每次写转录时是否在 batch 里。
const solidBatch = vi.hoisted(() => ({ depth: 0 }));
vi.mock('solid-js', async (importOriginal) => {
  const solid = await importOriginal<typeof import('solid-js')>();
  return {
    ...solid,
    batch: <T,>(fn: () => T): T => {
      solidBatch.depth += 1;
      try { return solid.batch(fn); } finally { solidBatch.depth -= 1; }
    },
  };
});

type StoreModule = typeof import('./acp-chat-store');
type Store = InstanceType<StoreModule['AcpChatStore']>;

// 桥必须在模块图加载之前就位(同 acp-chat-store.host-closed-6497.test.ts)。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    current: () => value,
    onChange: (cb: (value: T) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: () => () => undefined,
    ready: Promise.resolve(),
    push(next: T) {
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
  };
}

const readyState = {
  lifecycle: 'ready',
  activeTurnId: null,
  pendingPermissions: [],
  lastStopReason: null,
  lastTurnOutcome: 'none',
  queuedPrompts: [],
  backgroundAgentCount: 0,
  backgroundCommandCount: 0,
  isGenerating: false,
  canSubmit: true,
  canCancel: false,
  failure: null,
};

type Internal = {
  _bootstrapped: boolean;
  _subscribeLiveSession: (session: unknown) => void;
  _runBootstrap: () => Promise<void>;
  _refreshHistory: (options?: { preserveLiveTurn?: boolean }) => Promise<void>;
  _mergeRuntimeChanges: () => Promise<unknown>;
};

let seq = 0;
function attachedStore(initial: Record<string, unknown>) {
  seq += 1;
  const store = new AcpChatStore(`conv-6582-${seq}`, 'proj-1');
  const internal = store as unknown as Internal;
  vi.spyOn(internal, '_runBootstrap').mockResolvedValue(undefined);
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(initial),
    activeTurn: replica<unknown>(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({}),
    dispose: () => {},
  };
  runInAction(() => {
    internal._bootstrapped = true;
    store.historyLoading = false;
    store.session = session as unknown as Store['session'];
    internal._subscribeLiveSession(session);
  });
  return { store, session };
}

/** 库里读出来的一轮:带 startedAt(看上去是活的),卡上有任务 id、没有完成标记。 */
const storedTurn = {
  id: 'conv:turn:s3',
  seq: 3,
  startedAt: 1000,
  items: [{ kind: 'execute-tool-call', id: 'item-1', seq: 0, toolCallId: 'call_bg', title: 'sleep 600', status: 'done', backgroundTaskId: 'bg-old' }],
};

describe('#6582 runningBackgroundTaskIds', () => {
  it('刷新已落定回合里的原生子任务进度，并合并同一读取期间的后续更新', async () => {
    const { store, session } = attachedStore(readyState);
    let finish!: () => void;
    const refresh = vi.spyOn(store as unknown as Internal, '_refreshHistory')
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const child = { subagentSessionId: 'native-child', launchTurnId: 'committed-parent', status: 'running' };
    session.agents.push([child]);
    session.agents.push([{ ...child, activityVersion: 1 }]);
    session.agents.push([{ ...child, activityVersion: 2 }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ preserveLiveTurn: true });
    finish();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    store.dispose();
    session.agents.push([{ ...child, activityVersion: 3 }]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('刷新原生子任务的旧派发行时，保留仍活着的完成通知帧', async () => {
    const { store, session } = attachedStore(readyState);
    const internal = store as unknown as Internal;
    const live = { id: 'child-completion', seq: 1, initiator: 'agent' as const, items: [] };
    session.activeTurn.push(live);
    store.chatState.transcript.activeTurn.set(live);
    vi.spyOn(internal, '_mergeRuntimeChanges').mockResolvedValue(null);
    await internal._refreshHistory({ preserveLiveTurn: true });
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe(live.id);
    store.dispose();
  });

  it('子任务进度对账时，清掉活动轮与放回活动轮是转录的同一次更新（否则这一轮的行全被卸掉重挂，流式文字整段重新淡入）', async () => {
    const { store, session } = attachedStore(readyState);
    const internal = store as unknown as Internal;
    const live = { id: 'parent-follow-up', seq: 2, initiator: 'user' as const, items: [] };
    session.activeTurn.push(live);
    store.chatState.transcript.activeTurn.set(live);
    vi.spyOn(internal, '_mergeRuntimeChanges').mockResolvedValue(null);
    const writes: string[] = [];
    const { transcript } = store.chatState;
    const seed = transcript.history.seed.bind(transcript.history);
    const set = transcript.activeTurn.set.bind(transcript.activeTurn);
    vi.spyOn(transcript.history, 'seed').mockImplementation((turns) => { writes.push(`seed@${solidBatch.depth}`); seed(turns); });
    vi.spyOn(transcript.activeTurn, 'set').mockImplementation((turn, status) => {
      writes.push(`set:${turn?.id ?? null}@${solidBatch.depth}`);
      set(turn, status);
    });
    await internal._refreshHistory({ preserveLiveTurn: true });
    expect(writes).toEqual(['seed@1', `set:${live.id}@1`]);
    expect(transcript.state.activeTurnSnapshot?.id).toBe(live.id);
    store.dispose();
  });

  it('活会话报了哪些 id 就是哪些,之后的推送跟着变;id 没变不重复通知', () => {
    const { store, session } = attachedStore({ ...readyState, backgroundCommandCount: 1, backgroundCommandTaskIds: ['bg-new'] });
    expect(store.runningBackgroundTaskIds).toEqual(['bg-new']);

    const seen: Array<readonly string[] | null> = [];
    const stop = autorun(() => seen.push(store.runningBackgroundTaskIds));
    session.sessionState.push({ ...readyState, backgroundCommandCount: 1, backgroundCommandTaskIds: ['bg-new'], isGenerating: true });
    session.sessionState.push({ ...readyState, backgroundCommandTaskIds: [] });
    stop();
    expect(seen, '同样的 id 再推一次不该再通知一次(花名册会跟着重算、面板会重新判断弹不弹)').toEqual([['bg-new'], []]);
  });

  it('对面没报这一格(旧运行时)⇒ null:花名册不筛,保持旧行为', () => {
    const { store } = attachedStore(readyState);
    expect(store.runningBackgroundTaskIds).toBeNull();
    expect(collectBackgroundCommandRoster([storedTurn] as never, null, 'x', store.runningBackgroundTaskIds)).toHaveLength(1);
  });

  it('报了空数组 ⇒ 库里那张上一个进程的卡被筛掉(重启后的现场)', () => {
    const { store } = attachedStore({ ...readyState, backgroundCommandTaskIds: [] });
    expect(store.runningBackgroundTaskIds).toEqual([]);
    expect(collectBackgroundCommandRoster([storedTurn] as never, null, 'x', store.runningBackgroundTaskIds)).toEqual([]);
  });

  it('会话 lost(适配器 / worker 没了)⇒ [],哪怕上一刻还报着 id', () => {
    const { store, session } = attachedStore({ ...readyState, backgroundCommandTaskIds: ['bg-old'] });
    session.sessionState.push({ ...readyState, lifecycle: 'lost', backgroundCommandTaskIds: ['bg-old'] });
    expect(store.runningBackgroundTaskIds).toEqual([]);
  });

  it('宿主停掉会话(closed)⇒ 句柄还掉,[]', () => {
    const { store, session } = attachedStore({ ...readyState, backgroundCommandTaskIds: ['bg-old'] });
    session.sessionState.push({ ...readyState, lifecycle: 'closed', backgroundCommandTaskIds: ['bg-old'] });
    expect(store.session).toBeNull();
    expect(store.runningBackgroundTaskIds).toEqual([]);
  });

  it('还没挂上会话 ⇒ [](没有活着的进程就没有在跑的命令)', () => {
    const store = new AcpChatStore('conv-6582-none', 'proj-1');
    expect(store.runningBackgroundTaskIds).toEqual([]);
  });
});
