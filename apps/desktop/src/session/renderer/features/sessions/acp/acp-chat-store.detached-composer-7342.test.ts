// @vitest-environment jsdom
/**
 * #7342 —— 通用模式会话停下后,输入框照旧说得出这条会话的模型、强度与最后一份上下文读数。
 *
 * ## 修复前是什么样(owner 实机截图,2026-10-16)
 *
 * 宿主停掉进程(闲置回收)⇒ `_onSessionClosedByHost` 扔掉句柄 ⇒ `model` / `effort` 只在「正在起」时
 * 读记录、其余答 null,触发器退回占位的「模型」;`usage` 只读活会话,圈不画了。
 * 而下一句发出去,宿主起它用的就是记录里那个模型 —— 值一直在,只是没画。
 *
 * ## 判据能判假吗
 *
 * 能:把 `get model()` 改回 `this.starting ? … : null`,第一条用例当场红(停下后答 null;mac1 实测)。
 */
import { describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';
import type { Session } from '@shared/core/sessions/sessions';

const records = vi.hoisted(() => new Map<string, Partial<Session>>());
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: {
    get: (id: string) =>
      records.has(id) ? { sessions: new Map([[id, { data: records.get(id) }]]) } : undefined,
  },
}));
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ getStoredQueue: vi.fn().mockResolvedValue([]), queuePrompt: vi.fn() }),
}));
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: (arg: unknown) => toasts.push(arg) }));

type StoreModule = typeof import('./acp-chat-store');
type Store = InstanceType<StoreModule['AcpChatStore']>;

Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
const invoke = vi.fn((..._args: unknown[]) => Promise.resolve([]));
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke,
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore }: StoreModule = await import('./acp-chat-store');

function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    current: () => value,
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: () => () => undefined,
    ready: Promise.resolve(),
    push(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
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
  isGenerating: false,
  canSubmit: true,
  canCancel: false,
  failure: null,
};

type LiveUsage = { contextUsed: number; contextSize: number; cost: null } | null;
let seq = 0;
function attached(input: { record: Partial<Session>; liveModel: string; liveUsage: LiveUsage }) {
  seq += 1;
  const store = new AcpChatStore(`conv-7342-${seq}`, 'proj-1');
  records.set(store.sessionId, input.record);
  const internal = store as unknown as {
    _bootstrapped: boolean;
    _subscribeLiveSession: (session: unknown) => void;
    _runBootstrap: () => Promise<void>;
  };
  vi.spyOn(internal, '_runBootstrap').mockResolvedValue(undefined);
  const session = {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({
      modelOptions: { selected: input.liveModel, available: [] },
      efforts: { selected: 'high', available: [] },
    }),
    usage: replica<LiveUsage>(input.liveUsage),
    dispose: () => {},
  };
  runInAction(() => {
    internal._bootstrapped = true;
    store.historyLoading = false;
    store.session = session as unknown as Store['session'];
    internal._subscribeLiveSession(session);
  });
  const close = () => session.sessionState.push({ ...readyState, lifecycle: 'closed', canSubmit: false });
  return { store, close };
}

const reading = { used: 42_000, size: 200_000, modelId: 'gpt-5.5', providerSessionId: 'native-1' };
const record: Partial<Session> = { model: 'gpt-5.5', effort: 'high', providerSessionId: 'native-1', contextUsage: reading };

describe('#7342 停下后的输入框', () => {
  it('宿主停掉之后:模型、强度读记录(下一次起就用它们),圈画最后那份读数', () => {
    const { store, close } = attached({
      record,
      liveModel: 'gpt-5.5',
      liveUsage: { contextUsed: 42_000, contextSize: 200_000, cost: null },
    });
    // 阳性对照:活着时读的是活会话。
    expect(store.model).toBe('gpt-5.5');
    close();
    expect(store.session, '场景成立:句柄已还掉').toBeNull();
    expect(store.starting, '不是「还在起」那一段 —— 修之前只有那一段读记录').toBe(false);
    expect(store.model, '停下了答 null ⇒ 触发器退回占位的「模型」').toBe('gpt-5.5');
    expect(store.effort).toBe('high');
    expect(store.usage).toEqual({ contextUsed: 42_000, contextSize: 200_000, cost: null });
  });

  it('停下后,记录里的读数属于已被换掉的原生会话(重来过):不画', () => {
    const { store, close } = attached({
      record: { ...record, providerSessionId: 'native-2' },
      liveModel: 'gpt-5.5',
      liveUsage: null,
    });
    close();
    expect(store.usage).toBeNull();
  });

  it('活着但这一轮还没报读数(刚重开):同一个模型就画记录那份,换了模型就不画', () => {
    expect(attached({ record, liveModel: 'gpt-5.5', liveUsage: null }).store.usage).toEqual({
      contextUsed: 42_000,
      contextSize: 200_000,
      cost: null,
    });
    expect(attached({ record, liveModel: 'gpt-5.5-mini', liveUsage: null }).store.usage).toBeNull();
  });

  it('分叉的侧边聊天借来源会话的 id:记录里那份是来源的读数,不画', () => {
    const { store } = attached({ record, liveModel: 'gpt-5.5', liveUsage: null });
    const side = new AcpChatStore(store.sessionId, 'proj-1', {
      id: `side-${store.sessionId}`,
      forkFromProviderSessionId: 'native-1',
    });
    expect(side.isTransient, '场景成立:这是一条运行时视图').toBe(true);
    expect(side.usage).toBeNull();
  });

  it('阴控 —— 活会话报了读数:画活的那份,不看记录', () => {
    const live = { contextUsed: 9, contextSize: 10, cost: null };
    expect(attached({ record, liveModel: 'gpt-5.5', liveUsage: live }).store.usage).toEqual(live);
  });
});

describe('#7342 停下后的权限那一格', () => {
  it('停下了:答记录里那一档;改档直接记进记录(下一次起按它设),不弹「not connected」', async () => {
    const { store, close } = attached({ record: { ...record, permissionMode: 'edit' }, liveModel: 'gpt-5.5', liveUsage: null });
    expect(store.detachedPermissionTier, '活着时有活会话的读数,这一格不答').toBeNull();
    close();
    expect(store.detachedPermissionTier).toBe('edit');

    toasts.length = 0;
    invoke.mockClear();
    await store.setMode(':danger-full-access');
    expect(toasts, '停下时摆出来的下拉点了就报错 = 假控件').toEqual([]);
    expect(invoke.mock.calls.some((call) => JSON.stringify(call).includes('"dimension":"permission","modeId":":danger-full-access"'))).toBe(true);
  });

  it('没记档位的会话(导入的):按编辑档', () => {
    const off = attached({ record: { ...record, permissionMode: undefined }, liveModel: 'gpt-5.5', liveUsage: null });
    off.close();
    expect(off.store.detachedPermissionTier).toBe('edit');
  });

  it('还在起:不答(启动参数已经发出去,此刻改记录 = 记录说一档、进程跑另一档)', () => {
    const { store, close } = attached({ record, liveModel: 'gpt-5.5', liveUsage: null });
    close();
    runInAction(() => {
      (store as unknown as { _bootstrapsInFlight: number })._bootstrapsInFlight = 1;
    });
    expect(store.starting, '场景成立:这是「还在起」那一段').toBe(true);
    expect(store.detachedPermissionTier).toBeNull();
  });
});
