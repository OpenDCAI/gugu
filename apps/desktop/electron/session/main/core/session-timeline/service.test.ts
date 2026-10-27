import * as asks from '../asks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PendingRequest,
  RecordCursor,
  SessionTimeline,
  Settlement,
  TimelineAfterResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record';

type Row = {
  id: string;
  title: string;
  provider: string | null;
  providerSessionId: string | null;
  runtime: string | null;
  agentStatus: string | null;
  lastInteractedAt: string | null;
  projectId: string;
  /** 会话配置(第一句话记在这里);多数用例不关心。 */
  config?: unknown;
};

const state = vi.hoisted(() => ({
  rows: [] as Array<{ session: Record<string, unknown>; project: Record<string, unknown> }>,
  /** 项目表里的本机项目(含还没有会话的)。 */
  projects: [] as Array<{ id: string; name: string; path: string }>,
  /** 这台机器上会话给自己排的定时(repo.listSessionSchedules 的桩);多数用例没有。 */
  schedules: [] as unknown[],
  deliverText: vi.fn(),
  deliverPermission: vi.fn(),
  prepareQuestion: vi.fn(),
  deliverQuestion: vi.fn(),
  questionSend: vi.fn(),
  /** 写侧「这条腿上有没有结算口」;null = 有。 */
  permissionChannelError: vi.fn(),
  /** 活运行时是否存在。null = 这台机器上没有 ACP 运行时进程（watch 返回 null）。 */
  pendingWatchAvailable: true,
  pendingWatchCalls: [] as string[],
  pendingWatchDisposed: 0,
  /** 用例手里的那根线：调它就等于运行时报了一批新的待答审批。 */
  emitPending: null as null | ((requests: PendingRequest[], queuedPrompts: { id: string; text: string }[]) => void),
  /** 活运行时报的会话选项(live-options 的桩);默认三格都没有。 */
  readOptions: vi.fn(async (): Promise<Record<string, unknown>> => ({ mode: null, model: null, effort: null })),
  /** D-31 The waits the host reported to the status writer, in order. */
  hostWaits: [] as Array<{ sessionId: string; id: string; open: boolean }>,
}));

const persistedQuestions = vi.hoisted(() => new Map<string, Settlement[]>());
vi.mock('../sessions/agent-question-store', () => ({
  readAgentQuestionRecords: (id: string) => persistedQuestions.get(id) ?? [],
  rememberAgentQuestion: (id: string, item: PendingRequest | Settlement) => {
    if (item.origin?.source !== 'agent-question') return;
    const items = persistedQuestions.get(id) ?? [];
    if (!items.some(old => old.itemId === item.itemId)) persistedQuestions.set(id, [...items, 'state' in item ? item : { ...item, state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null } as Settlement]);
  },
  settleAgentQuestionRecord: (id: string, itemId: string, result: { state: Settlement['state']; optionId: string | null; by: string | null }) => {
    persistedQuestions.set(id, (persistedQuestions.get(id) ?? []).map(item => item.itemId === itemId ? { ...item, state: result.state, optionId: result.optionId, resolvedBy: result.by } : item));
  },
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ all: () => state.rows.map((row) => ({ ...row })) }),
        }),
        where: () => ({ orderBy: () => ({ all: () => state.projects.map((project) => ({ ...project })) }) }),
      }),
    }),
  },
}));

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const openedOutputs = vi.hoisted(() => new Map<string, ({ kind: 'file'; path: string } | { kind: 'page'; url: string })[]>());
vi.mock('../sessions/session-outputs', () => ({
  sessionOutputs: async (sessionId: string) => openedOutputs.get(sessionId) ?? [],
  sessionOpenedFile: async (sessionId: string, path: string) =>
    (openedOutputs.get(sessionId) ?? []).some((output) => output.kind === 'file' && output.path === path),
}));
vi.mock('../sessions/sendMessage', () => ({ sendMessage: (...args: unknown[]) => state.questionSend(...args) }));
vi.mock('@main/core/automations/repo', () => ({ listSessionSchedules: () => state.schedules }));
/** 主进程推给渲染层的事件的旁听者(tapMainEvents);用例直接调它们,等于「主进程广播了一条」。 */
const mainTaps = vi.hoisted(() => new Set<(channel: string, data: unknown) => void>());
vi.mock('@main/lib/events', () => ({
  events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
  tapMainEvents: (tap: (channel: string, data: unknown) => void) => {
    mainTaps.add(tap);
    return () => mainTaps.delete(tap);
  },
}));

// 三家都是 runtime 注入 ⇒ 没有托管配置根。这里钉住那条事实，让用例不依赖真实插件表。
vi.mock('@gugu/session-core/agents/plugins/helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentHome: () => null,
}));
// 只有 claude 声明了终端提问的取消键(#6798、#7035)。
vi.mock('@main/core/agents/plugin-registry', () => ({
  isValidProviderId: (id: string) => id !== 'nope',
  getPlugin: (id: string) => {
    if (id === 'nope') throw new Error(`No plugin found for provider: ${id}`);
    const declared = id === 'claude';
    return {
      capabilities: {
        // hermes 声明了权限档表(impl/hermes/permission-modes.ts 的 HERMES_PERMISSION_MODES 同形);别的家在这里都没声明。
        ...(id === 'hermes'
          ? { autoApprove: { kind: 'supported', modes: { edit: { id: 'default' }, 'full-access': { id: 'yolo' } } } }
          : {}),
        sessionBundle: {
          injectionMode: 'runtime',
          configRoot: undefined,
          ...(declared ? { sessionTuiQuestionAnswer: { cancel: '\u001b', settleMs: 20, maxWaitMs: 2000, evidence: 'x' } } : {}),
        },
      },
      behavior: { sessionBundle: {} },
    };
  },
}));

// ❌ 不用 importOriginal:真 write-bridge 会把 ACP 运行时宿主(electron app-scope)一起拉起来,
// 而这一组用例问的是服务层的账,不是写侧的实现。桩里自带同一个错误类型,`instanceof` 仍然成立
// (被测模块和用例拿到的是同一个被 mock 的模块对象)。
vi.mock('./write-bridge', () => {
  class SessionWriteError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'SessionWriteError';
      this.code = code;
    }
  }
  return {
    SessionWriteError,
    deliverSessionText: (...args: unknown[]) => state.deliverText(...args),
    acpSessionLive: async () => false,
    ensureAcpSessionLive: async () => {
      throw new Error('❌ 没开起来的会话不许走唤醒');
    },
    deliverPermissionDecision: (...args: unknown[]) => state.deliverPermission(...args),
    permissionChannelError: (...args: unknown[]) => state.permissionChannelError(...args),
    prepareQuestionAnswer: (...args: unknown[]) => state.prepareQuestion(...args),
    deliverQuestionAnswer: (...args: unknown[]) => state.deliverQuestion(...args),
  };
});

// 同 write-bridge 的理由:真 live-permissions 会把 ACP 运行时宿主(electron app-scope)拉起来。
// service.ts 静态引 live-options ⇒ 会拖进 ACP 宿主(取 electron app 作用域),
// 这个文件根本不测那条路。与 live-permissions 同一条理由、同一种挡法。
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: { reportHostWait: (wait: { sessionId: string; id: string; open: boolean }) => state.hostWaits.push(wait) },
}));
vi.mock('./live-options', () => ({
  SessionOptionsError: class extends Error { code = 'x' },
  readSessionOptions: () => state.readOptions(),
  setSessionOption: async () => ({ mode: null, model: null, effort: null }),
}));

// 起会话失败的原因码:真实现读 kv 表,这里只要一张账。
const startFailures = vi.hoisted(() => new Map<string, string>());
vi.mock('./start-failures', () => ({
  readStartFailure: (id: string) => startFailures.get(id) ?? null,
  recordStartFailure: (id: string, code: string) => startFailures.set(id, code),
  clearStartFailure: (id: string) => startFailures.delete(id),
}));

const startCalls = vi.hoisted(() => [] as string[]);
vi.mock('./create-session', () => ({
  startSession: async (id: string) => {
    startCalls.push(id);
    return { ok: true, value: { started: true } };
  },
}));
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: async () => ({ modelId: 'gpt-5' }),
}));
vi.mock('@main/core/agents/session-discovery', () => ({
  listLocalModels: async () => ({ models: [{ id: 'platform:gpt-5', name: 'GPT-5' }] }),
}));

// 本机名录:只有 conv-1 有 agent 身份。
const roster = vi.hoisted(() => ({ read: async (): Promise<Map<string, string>> => new Map([['conv-1', 'user:agent-1']]) }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({
  agentIdsBySession: () => roster.read(),
}));
vi.mock('./live-permissions', () => ({
  watchSessionState: async (
    conversationId: string,
    onChange: (requests: PendingRequest[], queuedPrompts: { id: string; text: string }[]) => void
  ) => {
    state.pendingWatchCalls.push(conversationId);
    if (!state.pendingWatchAvailable) return null;
    state.emitPending = onChange;
    return {
      dispose: () => {
        state.pendingWatchDisposed += 1;
        state.emitPending = null;
      },
    };
  },
}));

const { SessionWriteError } = await import('./write-bridge');
const service = await import('./service');
const { log } = await import('@main/lib/logger');
const broadcast = (channel: string, data: unknown) => {
  for (const tap of [...mainTaps]) tap(channel, data);
};

function row(overrides: Partial<Row> = {}): {
  session: Row;
  project: { id: string; name: string; path: string };
} {
  const session: Row = {
    id: 'conv-1',
    title: '会话一',
    provider: 'claude',
    providerSessionId: 'sess-1',
    runtime: 'acp',
    agentStatus: 'idle',
    lastInteractedAt: '2026-09-04T00:00:00Z',
    projectId: 'proj-1',
    ...overrides,
  };
  return {
    session,
    project: { id: session.projectId, name: 'demo', path: '/repo/demo' },
  };
}

/** 最小 timeline 桩：结算是真的 CAS（这一条正是被测服务所依赖的不变量）。 */
function makeTimeline(onCatchUp: () => void = () => undefined) {
  const settlements = new Map<string, Settlement>();
  let queuedPrompts: { id: string; text: string }[] = [];
  const listeners = new Set<(result: TimelineAfterResult) => void>();
  const timeline: SessionTimeline & { disposed: number; listenerCount: () => number } = {
    epoch: 'e1',
    disposed: 0,
    listenerCount: () => listeners.size,
    getSnapshot: (): TimelineSnapshot => ({
      cursor: { epoch: 'e1', seq: 0 },
      turns: [],
      settlements: [...settlements.values()],
      hasOlder: false,
      queuedPrompts,
    }),
    getAfter: (cursor: RecordCursor): TimelineAfterResult => ({
      ok: true,
      batch: { from: cursor.seq, cursor, turns: [], removedTurnIds: [], settlements: [] },
    }),
    getOlder: ({ beforeTurnId }: { beforeTurnId: string; limit?: number }) => ({
      epoch: 'e1',
      turns: [],
      // 把入参回显出来,用例才判得出「服务层把 beforeTurnId 原样递下去了」。
      hasOlder: beforeTurnId === 'has-more',
    }),
    subscribe: (_cursor, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle: ({ itemId, optionId, by }) => {
      const existing = settlements.get(itemId);
      if (existing && existing.state !== 'pending') return { ok: false, existing };
      const settlement: Settlement = {
        ...(existing ?? { itemId }),
        itemId,
        state: 'resolved',
        optionId,
        resolvedBy: by,
        resolvedAt: 1,
      };
      settlements.set(itemId, settlement);
      return { ok: true, settlement };
    },
    // 两个动词照真语义建模，别都做成"删掉" —— 那样"放回可答"与"已取消"在断言里长得一样，
    // 而这两者的区别正是这条通道要守的东西。
    cancelSettlement: (itemId) => {
      const existing = settlements.get(itemId);
      if (!existing) return;
      settlements.set(itemId, {
        ...existing,
        state: 'cancelled',
        optionId: null,
        resolvedBy: null,
        resolvedAt: 2,
      });
    },
    // 照真语义建模：报进来的落 pending，报过又消失的 pending 转 cancelled。
    // 做成"照单全收"会让"已答的不许被拉回 pending"这条不变量在断言里消失。
    syncPendingRequests: (requests) => {
      const present = new Set(requests.map((request) => request.itemId));
      for (const request of requests) {
        const existing = settlements.get(request.itemId);
        if (existing && existing.state !== 'pending') continue;
        settlements.set(request.itemId, {
          itemId: request.itemId,
          kind: request.kind,
          title: request.title,
          ...(request.options.length > 0 ? { options: request.options } : {}),
          ...(request.origin ? { origin: request.origin } : {}),
          ...(request.questions ? { questions: request.questions, askedAt: request.askedAt } : {}),
          state: 'pending',
          optionId: null,
          resolvedBy: null,
          resolvedAt: null,
        });
      }
      for (const [itemId, settlement] of settlements) {
        if (present.has(itemId) || settlement.state !== 'pending') continue;
        settlements.set(itemId, { ...settlement, state: 'cancelled', resolvedAt: 3 });
      }
    },
    syncLiveReply: () => undefined,
    syncQueuedPrompts: (prompts) => {
      queuedPrompts = prompts.map(({ id, text }) => ({ id, text }));
    },
    releaseSettlement: (itemId) => {
      const existing = settlements.get(itemId);
      if (!existing || existing.state !== 'resolved') return;
      settlements.set(itemId, {
        ...existing,
        state: existing.resultRecorded ? 'cancelled' : 'pending',
        optionId: null,
        resolvedBy: null,
        resolvedAt: existing.resultRecorded ? 6 : null,
      });
    },
    catchUp: async () => onCatchUp(),
    questionOpen: (itemId) => {
      const existing = settlements.get(itemId);
      return !!existing?.questions && !existing.resultRecorded && existing.state !== 'cancelled';
    },
    dispose: () => {
      timeline.disposed += 1;
    },
  };
  const emit = (result: TimelineAfterResult) => {
    for (const listener of listeners) listener(result);
  };
  /**
   * 记录里这道提问出了结果(provider 写下 tool_result),照真 timeline:选择器关了;认领过的照旧,
   * 没人认领的:正常结束 = 在别处答了(resolved,不知是谁),失败(拒答 / 被停)= 作废。
   */
  const record = (itemId: string, status: 'completed' | 'failed' = 'completed') => {
    const existing = settlements.get(itemId)!;
    settlements.set(itemId, existing.state === 'pending'
      ? { ...existing, resultRecorded: true, state: status === 'completed' ? 'resolved' : 'cancelled', resolvedAt: 5 }
      : { ...existing, resultRecorded: true });
  };
  const put = (settlement: Settlement) => settlements.set(settlement.itemId, settlement);
  return { timeline, emit, record, put };
}

describe('session timeline service', () => {
  beforeEach(() => {
    persistedQuestions.clear();
    service.resetSessionTimelineService();
    service.setSessionTimelineFactory(null);
    service.setConnectionConfigRootResolver(null);
    state.pendingWatchAvailable = true;
    state.pendingWatchCalls = [];
    state.pendingWatchDisposed = 0;
    state.emitPending = null;
    state.rows = [row()];
    state.projects = [];
    state.deliverText = vi.fn(async () => ({ accepted: 'started' as const }));
    state.deliverPermission = vi.fn(async () => undefined);
    state.prepareQuestion = vi.fn();
    state.deliverQuestion = vi.fn();
    state.permissionChannelError = vi.fn(() => null);
    state.questionSend.mockReset().mockResolvedValue({ status: 'delivered' });
  });

  it('listSessions 按 projects 分组，supported 如实', async () => {
    state.rows = [
      row(),
      row({ id: 'conv-2', provider: 'gemini', projectId: 'proj-1' }),
      row({ id: 'conv-3', provider: 'codex', providerSessionId: null, projectId: 'proj-2' }),
      row({ id: 'conv-4', provider: 'opencode', runtime: 'node' }),
    ];
    const result = await service.listSessions();
    expect(result.projects.map((p) => p.id)).toEqual(['proj-1', 'proj-2']);
    const byId = new Map(result.sessions.map((s) => [s.conversationId, s]));
    expect(byId.get('conv-1')?.supported).toBe(true);
    expect(byId.get('conv-2')?.supported).toBe(false);
    expect(byId.get('conv-2')?.unsupportedReason).toContain('gemini');
    // 没有 provider 会话 id ⇒ 没有记录可读，但要说清是这一种，不是「不认识 codex」。
    expect(byId.get('conv-3')?.unsupportedReason).toContain('尚未真正开出会话');
    // runtime 列出现第三种值时如实报 unknown，❌ 不折成 pty。
    expect(byId.get('conv-4')?.runtime).toBe('unknown');
    expect(byId.get('conv-1')?.harness).toBe('claude');
    // 行上带 agent 的 id(名录里的绑定;显示名由看的一端去云端取),没有身份的是 null。
    expect(byId.get('conv-1')?.agent).toEqual({ userId: 'agent-1' });
    expect(byId.get('conv-2')?.agent).toBeNull();
  });

  it('心跳摘要那一份(listSessionStates)不读名录、不报 agent', () => {
    state.rows = [row()];
    expect(service.listSessionStates().sessions[0]).not.toHaveProperty('agent');
  });

  it('#7221 行上带它给自己排的定时摘要(心跳那一份也带:机器离线时手机看的就是它);没有就是 null', () => {
    const nextRunAt = Date.UTC(2026, 9, 19, 2, 30);
    state.rows = [row(), row({ id: 'conv-2' })];
    state.schedules = [
      { id: 'a-1', sessionId: 'conv-1', title: '检查 CI 结果', prompt: 'look', trigger: { expr: '', at: nextRunAt }, enabled: true, nextRunAt, lastRun: null },
    ];
    try {
      const byId = new Map(service.listSessionStates().sessions.map((s) => [s.conversationId, s]));
      expect(byId.get('conv-1')?.schedule).toEqual({ count: 1, nextAt: new Date(nextRunAt).toISOString(), title: '检查 CI 结果', attention: null });
      expect(byId.get('conv-2')?.schedule).toBeNull();
    } finally {
      state.schedules = [];
    }
  });

  it('#6985 还没开过会话的项目也列出来(手机新建会话只能挑列出来的项目);有会话的项目在前、不重复', async () => {
    state.rows = [row({ projectId: 'proj-1' })];
    state.projects = [
      { id: 'proj-new', name: 'demo', path: '/home/tester/demo' },
      { id: 'proj-1', name: 'p1', path: '/p1' },
      // 隐式任务工作区:没会话时不算一个项目(侧栏也不列)。
      { id: '00000000-0000-4000-8000-000000000001', name: '任务工作区', path: '/home/tester/task-home' },
    ];
    const result = await service.listSessions();
    expect(result.projects.map((p) => p.id)).toEqual(['proj-1', 'proj-new']);
    expect(result.projects.find((p) => p.id === 'proj-new')).toEqual({ id: 'proj-new', name: 'demo', path: '/home/tester/demo' });
    expect(result.sessions).toHaveLength(1);
  });

  it('没装记录源时 fail loud，不返回空时间线', async () => {
    const result = await service.snapshot({ conversationId: 'conv-1' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'timeline_unavailable', message: expect.any(String) },
    });
  });

  it('找不到会话报 session_not_found', async () => {
    service.setSessionTimelineFactory(async () => makeTimeline().timeline);
    expect(await service.snapshot({ conversationId: 'nope' })).toMatchObject({
      error: { code: 'session_not_found' },
    });
  });

  it('没有记录可读(这一家没接 / 还没开起来)也打得开:快照是第一句话,❌ record_unsupported', async () => {
    const factory = vi.fn(async () => makeTimeline().timeline);
    service.setSessionTimelineFactory(factory);
    state.rows = [row({ provider: 'gemini', config: { type: 'acp', firstUtterance: '看看这张图 @[a.png](/r/a.png)' } })];
    const unsupported = await service.snapshot({ conversationId: 'conv-1' });
    expect(unsupported).toMatchObject({ ok: true, value: { hasOlder: false, settlements: [] } });
    const turns = unsupported.ok ? unsupported.value.turns : [];
    expect(turns).toHaveLength(1);
    expect(turns[0]!.items[0]).toMatchObject({ kind: 'message', role: 'user', text: '看看这张图 @[a.png](/r/a.png)' });
    expect(factory).not.toHaveBeenCalled();

    state.rows = [row({ providerSessionId: null, config: { type: 'acp', initialQueue: [{ text: 'hi' }] } })];
    expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true });
    // 还没开出来的会话没有可回答的请求:如实说,❌ 抛。
    await expect(
      service.respond({ conversationId: 'conv-1', itemId: 'x', optionId: 'y', kind: 'permission', by: 'desktop' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'session_not_started' } });
  });

  it('单一目录之前绑在非原生连接上的会话:用户根优先,那条连接自己的配置根排最后兜底;原生会话不带它', async () => {
    const factory = vi.fn(async () => makeTimeline().timeline);
    service.setSessionTimelineFactory(factory);
    service.setConnectionConfigRootResolver((provider, id) => (provider === 'claude' && id !== 'native' ? `/conn/${id}/.claude` : null));
    const rootsOf = () => (factory.mock.calls.at(-1) as unknown as [{ locator: { roots: string[] } }])[0].locator.roots;

    state.rows = [row({ config: { type: 'acp', subscriptionConnectionId: 'conn-1' } })];
    await service.snapshot({ conversationId: 'conv-1' });
    // 搬家后新内容只长在用户根里;连接根里那份是搬家时的旧副本,只给搬失败的兜底。
    expect(rootsOf().at(-1)).toBe('/conn/conn-1/.claude/projects');
    expect(rootsOf().length).toBeGreaterThan(1);

    service.resetSessionTimelineService();
    state.rows = [row({ config: { type: 'acp', subscriptionConnectionId: 'native' } })];
    await service.snapshot({ conversationId: 'conv-1' });
    expect(rootsOf().some((root) => root.startsWith('/conn/'))).toBe(false);
  });

  it('还没启动过的外部 fork 没有自己的绑定:顺着 forkedFrom 用源会话那条连接的根;解析器抛错只退回默认根', async () => {
    const factory = vi.fn(async () => makeTimeline().timeline);
    service.setSessionTimelineFactory(factory);
    service.setConnectionConfigRootResolver((_provider, id) => `/conn/${id}/.claude`);
    const rootsOf = () => (factory.mock.calls.at(-1) as unknown as [{ locator: { roots: string[] } }])[0].locator.roots;
    state.rows = [
      row({ id: 'src', providerSessionId: 'sess-src', config: { type: 'acp', subscriptionConnectionId: 'conn-1' } }),
      row({ id: 'fork', providerSessionId: 'sess-fork', config: { type: 'pty', forkedFrom: { sessionId: 'src', title: 's' } } }),
    ];
    await service.snapshot({ conversationId: 'fork' });
    expect(rootsOf().at(-1)).toBe('/conn/conn-1/.claude/projects');

    service.resetSessionTimelineService();
    service.setConnectionConfigRootResolver(() => { throw new Error('userData unavailable'); });
    await service.snapshot({ conversationId: 'fork' });
    expect(rootsOf().some((root) => root.startsWith('/conn/'))).toBe(false);
  });

  it('从没开起来的会话(不论有没有记下原因码):发消息先按「再试一次」那条路起来,读选项不唤醒、报建时选的模型', async () => {
    startCalls.length = 0;
    state.deliverText.mockResolvedValue({ accepted: 'started' });
    state.rows = [row({ providerSessionId: null, config: { type: 'acp', initialQueue: [{ text: 'hi' }] } })];
    await service.send('conv-1', '在吗');
    expect(startCalls).toEqual(['conv-1']);
    expect(await service.sessionOptions({ conversationId: 'conv-1' })).toEqual({
      ok: true,
      value: { mode: null, effort: null, model: { selected: 'platform:gpt-5', available: [{ id: 'platform:gpt-5', name: 'GPT-5' }] } },
    });
  });

  // #6693:手机的权限档胶囊照桌面那一份排 —— 宿主随选项给出这家声明的档位表;没声明的家不给,手机照它报的名字显示。
  it('读选项时附上这家声明的权限档表,没声明的家不附', async () => {
    const mode = { selected: 'default', available: [{ id: 'default', name: 'default' }, { id: 'yolo', name: 'yolo' }] };
    state.rows = [row({ provider: 'hermes', runtime: 'pty' })];
    state.readOptions.mockResolvedValueOnce({ mode, model: null, effort: null });
    expect(await service.sessionOptions({ conversationId: 'conv-1' })).toEqual({
      ok: true,
      value: { mode, model: null, effort: null, modeMap: { edit: { id: 'default' }, 'full-access': { id: 'yolo' } } },
    });

    state.rows = [row({ provider: 'gemini', runtime: 'pty' })];
    state.readOptions.mockResolvedValueOnce({ mode, model: null, effort: null });
    expect(await service.sessionOptions({ conversationId: 'conv-1' })).toEqual({
      ok: true,
      value: { mode, model: null, effort: null },
    });
  });

  it('会话列表说清为什么没有记录、上次起它失败的原因码', async () => {
    startFailures.set('conv-2', 'platform_model_unreachable');
    state.rows = [
      row({ id: 'conv-1', provider: 'gemini' }),
      row({ id: 'conv-2', providerSessionId: null }),
      row({ id: 'conv-3' }),
    ];
    const { sessions } = await service.listSessions();
    expect(sessions.find((s) => s.conversationId === 'conv-1')).toMatchObject({ supported: false, recordState: 'harness-unsupported' });
    expect(sessions.find((s) => s.conversationId === 'conv-2')).toMatchObject({
      supported: false,
      recordState: 'not-started',
      startFailure: 'platform_model_unreachable',
    });
    expect(sessions.find((s) => s.conversationId === 'conv-3')).not.toHaveProperty('recordState');
  });

  it('同一条会话只开一份 timeline（两个端看同一个 epoch）', async () => {
    const factory = vi.fn(async () => makeTimeline().timeline);
    service.setSessionTimelineFactory(factory);
    await Promise.all([
      service.snapshot({ conversationId: 'conv-1' }),
      service.snapshot({ conversationId: 'conv-1' }),
      service.snapshot({ conversationId: 'conv-1' }),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  // owner 10-15:手机那份时间线里图只有类型和字数,图滚到了才来这里取(transport-trim)。和翻页同一条路。
  it('手机取一张工具图:按条目 id 和第几张找(工具组里的子调用也认);找不到如实说是哪一样没有', async () => {
    const fake = makeTimeline();
    const shot = { mimeType: 'image/jpeg', data: '/9j/AAAA' };
    const tool = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: 'app_check', status: 'done', ...extra });
    const snapshot = fake.timeline.getSnapshot();
    fake.timeline.getSnapshot = () => ({
      ...snapshot,
      turns: [{ id: 't1', seq: 1, initiator: 'user', items: [tool('tool-1', { images: [shot] }), tool('group-1', { kind: 'tool-group', children: [tool('child-1', { images: [shot, shot] })] })] }],
    }) as unknown as TimelineSnapshot;
    service.setSessionTimelineFactory(async () => fake.timeline);
    expect(await service.toolImage({ conversationId: 'conv-1', itemId: 'tool-1', index: 0 })).toEqual({ ok: true, value: shot });
    expect(await service.toolImage({ conversationId: 'conv-1', itemId: 'child-1', index: 1 })).toEqual({ ok: true, value: shot });
    expect(await service.toolImage({ conversationId: 'conv-1', itemId: 'tool-1', index: 1 })).toMatchObject({ ok: false, error: { code: 'no_such_image' } });
    expect(await service.toolImage({ conversationId: 'conv-1', itemId: 'gone', index: 0 })).toMatchObject({ ok: false, error: { code: 'no_such_item' } });
    expect(await service.toolImage({ conversationId: 'no-such-conv', itemId: 'tool-1', index: 0 })).toMatchObject({ ok: false, error: { code: 'session_not_found' } });
  });

  it('结算只成功一次：后答的一端拿到那条既有结算，provider 只被调一次', async () => {
    const { timeline } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    const request = {
      conversationId: 'conv-1',
      itemId: 'req-1',
      optionId: 'allow-once',
      kind: 'permission' as const,
    };
    const first = await service.respond({ ...request, by: 'phone' });
    const second = await service.respond({ ...request, by: 'desktop' });

    expect(first).toMatchObject({
      ok: true,
      value: { accepted: true, settlement: { resolvedBy: 'phone' } },
    });
    // 抢跑失败走**正常应答**并带回那条权威结算 —— 端上要显示「已在 phone 回答」,
    // 而一个只有 message 的错误里没有这条信息。
    // ⚠️ 这条以前断言的是 `{ok:false, error:{code:'already_settled'}}`,而端上等的是
    //    另一个形状:两边各写各的,真机上一点审批就把渲染层打崩(2026-09-05 实测)。
    expect(second).toMatchObject({
      ok: true,
      value: { accepted: false, settlement: { resolvedBy: 'phone' } },
    });
    expect(state.deliverPermission).toHaveBeenCalledTimes(1);
  });

  it('投递失败时把结算放回去，并把 provider 的 code 原样带出来', async () => {
    const { timeline } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    state.deliverPermission = vi.fn(async () => {
      throw new SessionWriteError('no_permission_channel', 'pty 腿没有权限回答通道');
    });
    const result = await service.respond({
      conversationId: 'conv-1',
      itemId: 'req-1',
      optionId: 'allow-once',
      kind: 'permission',
      by: 'phone',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'no_permission_channel' } });
    // 放回去了 ⇒ 换一条通道还能再答一次，而不是永远显示「已答」。
    // ❌ 也不能是 cancelled：那会把一个还在等人答的审批显示成已了结。
    expect(timeline.getSnapshot().settlements).toMatchObject([
      { itemId: 'req-1', state: 'pending', resolvedBy: null },
    ]);
  });

  it('#6739 这条腿上没有结算口 ⇒ 抢之前就拒:不抢、不投,❌ 先推一条 resolved 再放回', async () => {
    const { timeline } = makeTimeline();
    const settle = vi.spyOn(timeline, 'settle');
    service.setSessionTimelineFactory(async () => timeline);
    state.permissionChannelError = vi.fn(() => new SessionWriteError('no_permission_channel', 'pty 腿没有权限回答通道'));
    const result = await service.respond({
      conversationId: 'conv-1',
      itemId: 'req-1',
      optionId: 'allow-once',
      kind: 'question',
      by: 'phone',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'no_permission_channel' } });
    // 抢了就会推一条 resolved 出去 —— 老版本手机收到它就停在「已在手机端回答」。
    expect(settle).not.toHaveBeenCalled();
    expect(state.deliverPermission).not.toHaveBeenCalled();
  });

  describe('#6798 #7035 终端提问:取消键关选择器 + 回答当消息发回,卡片跟着记录走', () => {
    const questions = [{
      question: '去哪?',
      multiSelect: false,
      options: [{ optionId: '北京', name: '北京' }, { optionId: '上海', name: '上海' }],
    }];
    const asked: Settlement = {
      itemId: 'ask-1', kind: 'question', title: '去哪?', questions, askedAt: 1000,
      state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
    };
    const answer = { conversationId: 'conv-1', itemId: 'ask-1', kind: 'question' as const, answers: [{ selected: ['北京'] }], by: 'phone' };
    const prepared = (text: string | null = '我在咕咕的提问卡里回答了…') => ({ cancel: { key: '\u001b', settleMs: 20, maxWaitMs: 2000 }, text });

    function setup(onCatchUp?: () => void) {
      state.rows = [row({ runtime: 'pty' })];
      const fake = makeTimeline(onCatchUp);
      fake.put(asked);
      service.setSessionTimelineFactory(async () => fake.timeline);
      state.prepareQuestion = vi.fn(() => prepared());
      return fake;
    }
    const settlementNow = (fake: ReturnType<typeof makeTimeline>) => fake.timeline.getSnapshot().settlements[0];

    it('能不能代答只在开时间线时判一次:终端腿 + 声明了的家才让提问带上题目', async () => {
      const factory = vi.fn(async (_input: { answerableQuestions?: boolean }) => makeTimeline().timeline);
      service.setSessionTimelineFactory(factory);
      state.rows = [row({ runtime: 'pty' }), row({ id: 'conv-2', runtime: 'acp' }), row({ id: 'conv-3', runtime: 'pty', provider: 'codex' })];
      for (const conversationId of ['conv-1', 'conv-2', 'conv-3']) await service.snapshot({ conversationId });
      expect(factory.mock.calls.map(([input]) => input.answerableQuestions)).toEqual([true, false, false]);
    });

    it('答上了:核对回答 → 认领 → 交给写侧(取消键、等关上、发回答)⇒ 受理', async () => {
      let catchUps = 0;
      setup(() => {
        catchUps += 1;
      });
      state.deliverQuestion = vi.fn(async (_target: unknown, _prepared: unknown, question: { askedAt: number; stillOpen: () => Promise<boolean> }) => {
        expect(question.askedAt).toBe(1000);
        expect(await question.stillOpen()).toBe(true);
        return { ok: true };
      });
      const result = await service.respond(answer);
      expect(state.prepareQuestion).toHaveBeenCalledWith(expect.anything(), questions, [{ selected: ['北京'] }]);
      expect(result).toMatchObject({ ok: true, value: { accepted: true, settlement: { state: 'resolved', resolvedBy: 'phone' } } });
      // 认领前追一次、写侧判一次(桩里只判一次)。
      expect(catchUps).toBe(2);
    });

    it('拒答:写侧拿到 decline,受理', async () => {
      setup();
      state.deliverQuestion = vi.fn(async () => ({ ok: true }));
      const result = await service.respond({ conversationId: 'conv-1', itemId: 'ask-1', kind: 'question', decline: true, by: 'phone' });
      expect(state.prepareQuestion).toHaveBeenCalledWith(expect.anything(), questions, 'decline');
      expect(result).toMatchObject({ ok: true, value: { accepted: true, settlement: { state: 'resolved', resolvedBy: 'phone' } } });
    });

    it('终端里已经答了、记录还没读进来:先追到文件尾,抢不到,一个键都不写', async () => {
      let caughtUp = false;
      const fake = setup(() => {
        if (!caughtUp) fake.record('ask-1');
        caughtUp = true;
      });
      const result = await service.respond(answer);
      expect(result).toMatchObject({ ok: true, value: { accepted: false, settlement: { state: 'resolved', resolvedBy: null, resultRecorded: true } } });
      expect(state.deliverQuestion).not.toHaveBeenCalled();
    });

    it('回答与题目对不上 ⇒ 不认领、不写,原因原样带出', async () => {
      const fake = setup();
      const settle = vi.spyOn(fake.timeline, 'settle');
      state.prepareQuestion = vi.fn(() => {
        throw new SessionWriteError('answer_invalid', '「广州」不是第 1 题的选项');
      });
      const result = await service.respond({ ...answer, answers: [{ selected: ['广州'] }] });
      expect(result).toMatchObject({ ok: false, error: { code: 'answer_invalid' } });
      expect(settle).not.toHaveBeenCalled();
      expect(state.deliverQuestion).not.toHaveBeenCalled();
    });

    it('一拍都没写就失败 ⇒ 放回 pending,可以重答', async () => {
      const fake = setup();
      state.deliverQuestion = vi.fn(async () => ({ ok: false, error: new SessionWriteError('session_not_live', 'x'), written: 0 }));
      const result = await service.respond(answer);
      expect(result).toMatchObject({ ok: false, error: { code: 'session_not_live' } });
      expect(settlementNow(fake)).toMatchObject({ state: 'pending', resolvedBy: null });
    });

    it('取消键写进去之前选择器被终端那头交上了 ⇒ 这条已经不需要回答了', async () => {
      const fake = setup();
      state.deliverQuestion = vi.fn(async () => {
        fake.record('ask-1');
        return { ok: false, error: new SessionWriteError('question_closed', 'x'), written: 0 };
      });
      const result = await service.respond(answer);
      expect(result).toMatchObject({ ok: false, error: { code: 'question_closed' } });
      expect(settlementNow(fake)).toMatchObject({ state: 'cancelled', resolvedBy: null, resultRecorded: true });
    });

    it('写了取消键、选择器还开着(终端不重画 / 记录迟迟没结果)⇒ 放回可答:再答只是再按一次取消键', async () => {
      for (const code of ['render_timeout', 'question_still_open']) {
        const fake = setup();
        state.deliverQuestion = vi.fn(async () => ({ ok: false, error: new SessionWriteError(code, 'x'), written: 1 }));
        const result = await service.respond(answer);
        expect(result).toMatchObject({ ok: false, error: { code } });
        expect(settlementNow(fake)).toMatchObject({ state: 'pending', resolvedBy: null });
      }
    });

    it('选择器关了、回答没发出去 ⇒ 作废这条,原因带回(手机据此提示直接发消息)', async () => {
      const fake = setup();
      state.deliverQuestion = vi.fn(async () => {
        fake.record('ask-1');
        return { ok: false, error: new SessionWriteError('answer_not_delivered', 'x'), written: 1 };
      });
      const result = await service.respond(answer);
      expect(result).toMatchObject({ ok: false, error: { code: 'answer_not_delivered' } });
      expect(settlementNow(fake)).toMatchObject({ state: 'cancelled', resultRecorded: true });
    });

    it('取消键写完没等到重画、终端那头已经交上了(竞态)⇒ 这条已经不需要回答了', async () => {
      const fake = setup();
      state.deliverQuestion = vi.fn(async () => {
        fake.record('ask-1');
        return { ok: false, error: new SessionWriteError('render_timeout', 'x'), written: 1 };
      });
      await service.respond(answer);
      expect(settlementNow(fake)).toMatchObject({ state: 'cancelled', resultRecorded: true });
    });

    it('问出这道题的 agent 进程已经不在了(resume 过)⇒ 作废,❌ 放回可答', async () => {
      const fake = setup();
      state.deliverQuestion = vi.fn(async () => ({ ok: false, error: new SessionWriteError('question_gone', 'x'), written: 0 }));
      const result = await service.respond(answer);
      expect(result).toMatchObject({ ok: false, error: { code: 'question_gone' } });
      expect(settlementNow(fake)).toMatchObject({ state: 'cancelled' });
    });

    it('结算不带题目(宿主判定答不了)⇒ 写侧的判据按「没有题目」拒,一个键都不写', async () => {
      const fake = setup();
      const { questions: _dropped, askedAt: _askedAt, ...unanswerable } = asked;
      fake.put(unanswerable);
      state.permissionChannelError = vi.fn(() => new SessionWriteError('no_permission_channel', 'x'));
      const result = await service.respond(answer);
      expect(state.permissionChannelError).toHaveBeenCalledWith(expect.anything(), 'question', undefined);
      expect(result).toMatchObject({ ok: false, error: { code: 'no_permission_channel' } });
      expect(state.prepareQuestion).not.toHaveBeenCalled();
      expect(state.deliverQuestion).not.toHaveBeenCalled();
    });
  });

  it('订阅：增量推给这条订阅，取消之后不再推', async () => {
    const { timeline, emit } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    const events: unknown[] = [];
    const subscribed = await service.subscribe(
      { conversationId: 'conv-1', subscriptionId: 'sub-1', cursor: null },
      (event) => events.push(event)
    );
    expect(subscribed.ok).toBe(true);

    emit({ ok: true, batch: { from: 2, cursor: { epoch: 'e1', seq: 3 }, turns: [], removedTurnIds: [], settlements: [] } });
    expect(events).toEqual([
      {
        subscriptionId: 'sub-1',
        result: expect.objectContaining({ ok: true }),
      },
    ]);

    service.unsubscribe('sub-1');
    expect(timeline.listenerCount()).toBe(0);
    emit({ ok: true, batch: { from: 3, cursor: { epoch: 'e1', seq: 4 }, turns: [], removedTurnIds: [], settlements: [] } });
    expect(events).toHaveLength(1);
  });

  it('同一个 subscriptionId 再订阅会顶掉前一条,不留下双份监听', async () => {
    const { timeline } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    const emit = vi.fn();
    await service.subscribe({ conversationId: 'conv-1', subscriptionId: 'sub-1', cursor: null }, emit);
    await service.subscribe({ conversationId: 'conv-1', subscriptionId: 'sub-1', cursor: null }, emit);
    expect(timeline.listenerCount()).toBe(1);
    service.unsubscribeAll();
    expect(timeline.listenerCount()).toBe(0);
  });

  it('send 把写侧的失败 code 原样带出来', async () => {
    state.deliverText = vi.fn(async () => {
      throw new SessionWriteError('session_not_live', '这条终端会话此刻没有活着的 PTY');
    });
    expect(await service.send('conv-1', '你好')).toMatchObject({
      ok: false,
      error: { code: 'session_not_live' },
    });
    expect(await service.send('missing', '你好')).toMatchObject({
      ok: false,
      error: { code: 'session_not_found' },
    });
  });

  it('没人订阅之后到点才 dispose', async () => {
    vi.useFakeTimers();
    try {
      const { timeline } = makeTimeline();
      service.setSessionTimelineFactory(async () => timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      vi.advanceTimersByTime(59_000);
      expect(timeline.disposed).toBe(0);
      vi.advanceTimersByTime(2_000);
      expect(timeline.disposed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 活运行时的待答审批 ───────────────────────────────────────────────────
  //
  // ACP 的审批是 `session/request_permission` —— 请求应答，不进会话记录。读侧永远看不到它，
  // 所以这条通道是唯一能让手机知道「有人在等你批」的路。

  it('ACP 腿：运行时报的待答审批进快照，成为可答的一项', async () => {
    const { timeline } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    await service.snapshot({ conversationId: 'conv-1' });
    expect(state.pendingWatchCalls).toEqual(['conv-1']);

    state.emitPending?.([
      {
        itemId: 'req-live-1',
        kind: 'permission',
        title: 'Write',
        detail: 'need-approval.txt',
        options: [
          { optionId: 'allow', name: '允许' },
          { optionId: 'reject', name: '拒绝' },
        ],
      },
    ], []);

    const snapshot = await service.snapshot({ conversationId: 'conv-1' });
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        settlements: [
          { itemId: 'req-live-1', state: 'pending', title: 'Write', options: expect.any(Array) },
        ],
      },
    });
  });

  it('ACP 腿：运行时里排着的提示进快照（桌面「Queued prompts」那一份），桌面删掉就跟着没了', async () => {
    const { timeline } = makeTimeline();
    service.setSessionTimelineFactory(async () => timeline);
    await service.snapshot({ conversationId: 'conv-1' });
    state.emitPending?.([], [{ id: 'qp-1', text: '排着的那句' }]);
    expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({
      ok: true,
      value: { queuedPrompts: [{ id: 'qp-1', text: '排着的那句' }] },
    });
    state.emitPending?.([], []);
    expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true, value: { queuedPrompts: [] } });
  });

  it('TUI 腿不订阅待答审批：那条腿上根本没有可结算的请求 id', async () => {
    state.rows = [row({ runtime: 'pty' })];
    service.setSessionTimelineFactory(async () => makeTimeline().timeline);
    await service.snapshot({ conversationId: 'conv-1' });
    // 阴性对照：换成 ACP 那一行，同一段代码必须订阅（否则这条断言对任何实现都成立）。
    expect(state.pendingWatchCalls).toEqual([]);
    service.resetSessionTimelineService();
    state.rows = [row({ runtime: 'acp' })];
    service.setSessionTimelineFactory(async () => makeTimeline().timeline);
    await service.snapshot({ conversationId: 'conv-1' });
    expect(state.pendingWatchCalls).toEqual(['conv-1']);
  });

  // ⚠️ 这一条断言的是「空」——接线整个断掉它照样绿。它的阳性对照是上面
  //    「运行时报的待答审批进快照」那一条：同一段代码、只差 watch 给不给得出订阅。
  it('这台机器没有 ACP 运行时进程时照常可读，只是没有审批卡', async () => {
    state.pendingWatchAvailable = false;
    service.setSessionTimelineFactory(async () => makeTimeline().timeline);
    const snapshot = await service.snapshot({ conversationId: 'conv-1' });
    expect(snapshot).toMatchObject({ ok: true, value: { settlements: [] } });
  });

  it('没有会话状态事实源时,订阅整机列表必须响亮失败', async () => {
    service.setSessionStatusFeed(null);
    const result = await service.subscribeSessions('subs-1', vi.fn());
    // ❌ 不许返回一个「订上了但永远不推」的成功:手机会一直等一个不会来的提醒,
    // 而屏幕上看不出任何异常。
    expect(result).toMatchObject({ ok: false, error: { code: 'status_feed_missing' } });
  });

  it('订上那一刻推一份整的;之后状态一变只推变了的那一行,连着的几跳合成一次;没变就不推', async () => {
    vi.useFakeTimers();
    try {
      let fire: (() => void) | null = null;
      let stopped = 0;
      service.setSessionStatusFeed((cb) => {
        fire = () => cb({
          sessionId: 'conv-1',
          projectId: 'project-1',
          reading: { status: 'needs_user', detail: 'approval', running: true, background: null },
          unseen: true,
          reviewGate: null,
          providerBlocker: null,
          statusSourceFault: null,
        });
        return () => { stopped += 1; };
      });
      state.rows = [row(), row({ id: 'conv-2', title: '会话二' })];
      const emit = vi.fn();
      expect(await service.subscribeSessions('subs-1', emit)).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].full.sessions.map((s: { conversationId: string }) => s.conversationId)).toEqual(['conv-1', 'conv-2']);

      // 连跳三下(working → needs_user → …)只该推一份,而且只有变了的那一行。
      state.rows = [row({ agentStatus: 'needs_user' }), row({ id: 'conv-2', title: '会话二' })];
      fire!();
      fire!();
      fire!();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][0]).toMatchObject({ subscriptionId: 'subs-1', removed: [] });
      expect(emit.mock.calls[1][0].changed.map((s: { conversationId: string }) => s.conversationId)).toEqual(['conv-1']);
      expect(emit.mock.calls[1][0]).not.toHaveProperty('full');

      // 又响了一下但列表没变:不推。
      fire!();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(2);

      // 退订之后不再推,且真的把上游那条 tap 停了。
      service.unsubscribeSessions('subs-1');
      expect(stopped).toBe(1);
      state.rows = [row({ agentStatus: 'idle' })];
      fire!();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(2);
    } finally {
      service.setSessionStatusFeed(null);
      vi.useRealTimers();
    }
  });

  it('等底期间被退订:不推整份、上游的 tap 摘掉、map 里不留这一条;等底期间的变化在底之后补推一次', async () => {
    const read = roster.read;
    try {
      service.setSessionStatusFeed(() => () => undefined);
      state.rows = [row()];
      // 一:等底期间退订
      let release: () => void = () => undefined;
      roster.read = () => new Promise((resolve) => { release = () => resolve(new Map([['conv-1', 'user:agent-1']])); });
      const emit = vi.fn();
      const pending = service.subscribeSessions('subs-gone', emit);
      service.unsubscribeSessions('subs-gone');
      release();
      expect(await pending).toMatchObject({ ok: false, error: { code: 'unsubscribed' } });
      expect(emit).not.toHaveBeenCalled();
      expect(mainTaps.size).toBe(0);
      // 再退订一次也拆不到什么(map 里没有它)
      service.unsubscribeSessions('subs-gone');

      // 二:等底期间来了变化 ⇒ 底推出去之后补一次。变化信号在等底时到(那时还推不了),行在之后才改:
      // 没有「补一次」,这一下就丢了 —— 之后再也没有信号来推它。
      vi.useFakeTimers();
      roster.read = () => new Promise((resolve) => { release = () => resolve(new Map([['conv-1', 'user:agent-1']])); });
      const emit2 = vi.fn();
      const pending2 = service.subscribeSessions('subs-late', emit2);
      broadcast('session:changed', { conversationId: 'conv-1', projectId: 'project-1', changes: { title: 'changed while listing' } });
      roster.read = read;
      release();
      expect(await pending2).toMatchObject({ ok: true });
      expect(emit2).toHaveBeenCalledTimes(1);
      expect(emit2.mock.calls[0]![0]).toHaveProperty('full');
      state.rows = [row({ title: 'changed while listing' })];
      await vi.advanceTimersByTimeAsync(250);
      expect(emit2).toHaveBeenCalledTimes(2);
      expect(emit2.mock.calls[1]![0].changed.map((r: { title: string }) => r.title)).toEqual(['changed while listing']);
    } finally {
      roster.read = read;
      service.unsubscribeSessions('subs-late');
      service.setSessionStatusFeed(null);
      vi.useRealTimers();
    }
  });

  it('第一份整的算不出来:订阅当场失败、错误照常交回(客户端的退避接住),❌ 回一个永远不推的「订上了」', async () => {
    const read = roster.read;
    try {
      service.setSessionStatusFeed(() => () => undefined);
      state.rows = [row()];
      roster.read = async () => { throw new Error('roster unreadable'); };
      const emit = vi.fn();
      expect(await service.subscribeSessions('subs-first', emit)).toMatchObject({ ok: false, error: { code: 'sessions_list_failed' } });
      expect(emit).not.toHaveBeenCalled();
      // 失败的那一次不留订阅:之后的变化不推、上游的 tap 也已摘掉。
      expect(mainTaps.size).toBe(0);
      roster.read = read;
      expect(await service.subscribeSessions('subs-first', emit)).toMatchObject({ ok: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'subs-first', full: expect.anything() }));
    } finally {
      roster.read = read;
      service.unsubscribeSessions('subs-first');
      service.setSessionStatusFeed(null);
    }
  });

  it('名录读坏了:这一份不推,响亮记一条;下一次变化照常推', async () => {
    vi.useFakeTimers();
    const read = roster.read;
    try {
      let fire: (() => void) | null = null;
      service.setSessionStatusFeed((cb) => {
        fire = () => cb({ sessionId: 'conv-1', projectId: 'project-1', reading: null, unseen: false, reviewGate: null, providerBlocker: null } as never);
        return () => undefined;
      });
      state.rows = [row()];
      const emit = vi.fn();
      await service.subscribeSessions('subs-broken', emit);
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).toHaveBeenCalledTimes(1);
      roster.read = async () => { throw new Error('roster unreadable'); };
      state.rows = [row({ title: 'renamed' })];
      fire!();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(vi.mocked(log.error)).toHaveBeenCalledWith('sessionTimeline: 会话列表推送列不出来', expect.objectContaining({ subscriptionId: 'subs-broken' }));
      roster.read = read;
      fire!();
      await vi.advanceTimersByTimeAsync(250);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][0].changed[0]).toMatchObject({ conversationId: 'conv-1', title: 'renamed' });
    } finally {
      roster.read = read;
      service.unsubscribeSessions('subs-broken');
      service.setSessionStatusFeed(null);
      vi.useRealTimers();
    }
  });

  it('会话增删与置顶、改名、归档、换父会话不经状态写入者,也各推一次变化;别的字段不推;退订后不再推', async () => {
    vi.useFakeTimers();
    try {
      service.setSessionStatusFeed(() => () => undefined);
      state.rows = [row()];
      const emit = vi.fn();
      expect(await service.subscribeSessions('subs-1', emit)).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).toHaveBeenCalledTimes(1);
      const at = { conversationId: 'conv-1', projectId: 'project-1' };
      let n = 0;
      // 每一下都让列表真的变一点(标题),推出去的就是那一行。
      const pushesAfter = async (channel: string, data: unknown) => {
        n += 1;
        state.rows = [row({ title: `t${n}` })];
        const before = emit.mock.calls.length;
        broadcast(channel, data);
        await vi.advanceTimersByTimeAsync(250);
        return emit.mock.calls.length - before;
      };

      expect(await pushesAfter('session:changed', { ...at, changes: { isPinned: true } })).toBe(1);
      expect(await pushesAfter('session:changed', { ...at, changes: { title: 'New name' } })).toBe(1);
      expect(await pushesAfter('session:changed', { ...at, changes: { archivedAt: null } })).toBe(1);
      expect(await pushesAfter('session:changed', { ...at, changes: { parentSessionId: null } })).toBe(1);
      expect(await pushesAfter('session:created', { session: { id: 'conv-2' } })).toBe(1);
      expect(await pushesAfter('session:deleted', at)).toBe(1);
      // #7221 行上那枚定时标记:排上 / 取消 / 到点 / 没送到都经 automation:* 两条。
      expect(await pushesAfter('automation:changed', { automationId: 'a-1' })).toBe(1);
      expect(await pushesAfter('automation:run-changed', { automationId: 'a-1', run: {} })).toBe(1);
      // 列表上不画的字段、别的频道:不为它们重列。
      expect(await pushesAfter('session:changed', { ...at, changes: { lastInteractedAt: '2026-09-27T10:00:00Z' } })).toBe(0);
      expect(await pushesAfter('task:changed', { ...at, changes: { title: 'x' } })).toBe(0);

      service.unsubscribeSessions('subs-1');
      expect(await pushesAfter('session:changed', { ...at, changes: { isPinned: false } })).toBe(0);
      expect(mainTaps.size).toBe(0);
    } finally {
      service.setSessionStatusFeed(null);
      vi.useRealTimers();
    }
  });

  it('时间线被拆时那条订阅也一起拆掉', async () => {
    vi.useFakeTimers();
    try {
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      expect(state.pendingWatchDisposed).toBe(0);
      vi.advanceTimersByTime(61_000);
      expect(state.pendingWatchDisposed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // D-31 (L11 复核 67): the host's ask for an agent — an App install — kept on the session's timeline, for a chat-UI session
  // and a terminal one alike; `respond` settles it once and hands it to the host. Nothing at this layer answers it for the
  // person (125 10-06: the full-access auto-approve sits in the runtime, which this ask never goes through).
  describe('D-31 the host asks the person in the session', () => {
    const ask = (itemId = 'host-1') => ({
      itemId,
      kind: 'permission' as const,
      title: 'Claude 1: install Reader',
      options: [
        { optionId: 'install', name: 'Install', kind: 'allow_once' },
        { optionId: 'decline', name: "Don't install", kind: 'reject_once' },
      ],
      origin: { source: 'app-install' as const, payload: { request: { manifestDigest: 'digest-r' } } },
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const settled = (promise: Promise<unknown>) => Promise.race([promise, flush().then(() => 'still asked')]);
    beforeEach(() => {
      state.hostWaits = [];
    });

    it('the registered App deadline withdraws the same settlement at 280 seconds', async () => {
      vi.useFakeTimers();
      try {
        state.rows = [row()];
        const fake = makeTimeline();
        service.setSessionTimelineFactory(async () => fake.timeline);
        const answer = asks.ask('conv-1', ask(), {});
        await service.snapshot({ conversationId: 'conv-1' });
        await vi.advanceTimersByTimeAsync(279_999);
        expect(fake.timeline.getSnapshot().settlements.find(item => item.itemId === 'host-1')?.state).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        await expect(answer).resolves.toBe('timeout');
        expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true, value: { settlements: [expect.objectContaining({ itemId: 'host-1', state: 'cancelled' })] } });
      } finally { vi.useRealTimers(); }
    });

    it('a browser source publishes dialog attention and settles through the same CAS', async () => {
      state.rows = [row()];
      const fake = makeTimeline();
      service.setSessionTimelineFactory(async () => fake.timeline);
      const answer = asks.ask('conv-1', { ...ask('browser-1'), origin: { source: 'browser-assistance', payload: { kind: 'takeover', text: 'Finish the visible step' } } }, {});
      await service.snapshot({ conversationId: 'conv-1' });
      await Promise.resolve();
      expect(state.hostWaits).toContainEqual(expect.objectContaining({ open: true, waitKind: 'dialog' }));
      const input = { conversationId: 'conv-1', itemId: 'browser-1', kind: 'permission' as const, optionId: 'install', by: 'mobile' };
      expect(await asks.respond(input)).toMatchObject({ ok: true, value: { accepted: true } });
      expect(await asks.respond({ ...input, by: 'desktop' })).toMatchObject({ ok: true, value: { accepted: false } });
      await expect(answer).resolves.toMatchObject({ by: 'mobile' });
    });

    it('a host question works on ACP, validates answers and commits only the first explicit answer', async () => {
      state.rows = [row({ runtime: 'acp' })];
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      const answered = asks.ask('conv-1', {
        itemId: 'agent-question:budget', kind: 'question', title: '预算？',
        questions: [{ question: '预算？', multiSelect: false, options: [{ optionId: '300', name: '300 元' }, { optionId: '500', name: '500 元' }] }],
        options: [], askedAt: 123, origin: { source: 'agent-question', payload: {} },
      }, { signal: new AbortController().signal });
      const snapshot = await service.snapshot({ conversationId: 'conv-1' });
      expect(snapshot).toMatchObject({ ok: true, value: { settlements: [expect.objectContaining({ questions: [expect.objectContaining({ question: '预算？' })], state: 'pending' })] } });
      const input = { conversationId: 'conv-1', itemId: 'agent-question:budget', kind: 'question' as const, by: 'desktop' };
      expect(await service.respond({ ...input, answers: [{ selected: ['obsolete'] }] })).toMatchObject({ ok: false, error: { code: 'answer_invalid' } });
      expect(await settled(answered)).toBe('still asked');
      expect(await service.respond({ ...input, answers: [{ selected: ['300'] }] })).toMatchObject({ ok: true, value: { accepted: true } });
      await expect(answered).resolves.toMatchObject({ answers: [{ selected: ['300'] }], by: 'desktop' });
      expect(await service.respond({ ...input, by: 'phone', answers: [{ selected: ['500'] }] })).toMatchObject({ ok: true, value: { accepted: false } });
      expect(state.deliverPermission).not.toHaveBeenCalled();
      expect(state.permissionChannelError).not.toHaveBeenCalled();
    });

    it('a question keeps the session waiting on the person (a question wait) until it is withdrawn on interruption', async () => {
      state.rows = [row({ runtime: 'acp' })];
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      const answered = asks.ask('conv-1', {
        itemId: 'agent-question:async', kind: 'question', title: 'Which?',
        questions: [{ question: 'Which?', multiSelect: false, options: [{ optionId: 'one', name: 'One' }] }],
        options: [], origin: { source: 'agent-question', payload: {} },
      }, { signal: new AbortController().signal });
      await service.snapshot({ conversationId: 'conv-1' });
      await vi.dynamicImportSettled();
      expect(state.hostWaits).toEqual([{ sessionId: 'conv-1', id: 'host-ask:agent-question:async', open: true, waitKind: 'question' }]);
      expect(await settled(answered)).toBe('still asked');
      asks.withdrawAll('conv-1');
      await expect(answered).resolves.toBe('withdrawn');
      await vi.dynamicImportSettled();
      expect(state.hostWaits.at(-1)).toEqual({ sessionId: 'conv-1', id: 'host-ask:agent-question:async', open: false, waitKind: 'question' });
      expect(await service.respond({ conversationId: 'conv-1', itemId: 'agent-question:async', kind: 'question', answers: [{ selected: ['one'] }], by: 'desktop' }))
        .toMatchObject({ ok: true, value: { accepted: false, settlement: { state: 'cancelled' } } });
    });

    it('a disconnected host question is withdrawn; an old answer cannot revive it', async () => {
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      const clock = new AbortController();
      const answered = asks.ask('conv-1', { itemId: 'agent-question:gone', kind: 'question', title: '继续？', questions: [{ question: '继续？', multiSelect: false, options: [] }], options: [], origin: { source: 'agent-question', payload: {} } }, { signal: clock.signal });
      await service.snapshot({ conversationId: 'conv-1' });
      clock.abort();
      await expect(answered).resolves.toBe('withdrawn');
      const late = await service.respond({ conversationId: 'conv-1', itemId: 'agent-question:gone', kind: 'question', answers: [{ selected: [], other: '继续' }], by: 'phone' });
      expect(late).toMatchObject({ ok: true, value: { accepted: false, settlement: { state: 'cancelled' } } });
    });

    it('a terminal session too: on its timeline, answered there, handed to the host — never to a runtime', async () => {
      state.rows = [row({ runtime: 'pty' })];
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      const answered = asks.ask('conv-1', ask(), { signal: new AbortController().signal });
      const before = await service.snapshot({ conversationId: 'conv-1' });
      expect(before).toMatchObject({ ok: true, value: { settlements: [{ itemId: 'host-1', state: 'pending', origin: { source: 'app-install' } }] } });
      const result = await service.respond({ conversationId: 'conv-1', itemId: 'host-1', kind: 'permission', optionId: 'install', digest: 'digest-r', enableIn: ['g1'], by: 'phone' });
      expect(result).toMatchObject({ ok: true, value: { accepted: true, settlement: { resolvedBy: 'phone' } } });
      await expect(answered).resolves.toEqual({ optionId: 'install', by: 'phone', digest: 'digest-r', enableIn: ['g1'] });
      // The terminal leg has no channel for the harness's approvals: never asked, never consulted for the host's.
      expect(state.deliverPermission).not.toHaveBeenCalled();
      expect(state.permissionChannelError).not.toHaveBeenCalled();
      // The status writer is imported when first asked: let that import land, then both edges are in, in order.
      await vi.dynamicImportSettled();
      expect(state.hostWaits).toEqual([
        { sessionId: 'conv-1', id: 'host-ask:host-1', open: true, waitKind: 'approval' },
        { sessionId: 'conv-1', id: 'host-ask:host-1', open: false, waitKind: 'approval' },
      ]);
    });

    it('nothing here answers it for the person: it stays asked, the runtime\'s own approvals beside it', async () => {
      const { timeline } = makeTimeline();
      service.setSessionTimelineFactory(async () => timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      const clock = new AbortController();
      const answered = asks.ask('conv-1', ask(), { signal: clock.signal });
      // The runtime reports its own set (none now, then one): the host's ask is not its to drop.
      state.emitPending?.([], []);
      state.emitPending?.([{ itemId: 'req-1', kind: 'permission', title: 'Run a command', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }], []);
      await expect(settled(answered)).resolves.toBe('still asked');
      expect(timeline.getSnapshot().settlements.map((one) => [one.itemId, one.state])).toEqual(
        expect.arrayContaining([['host-1', 'pending'], ['req-1', 'pending']])
      );
      // Asks live in the module, past the reset between cases: withdrawn here, so none is out when the next case opens.
      clock.abort();
      await answered;
    });

    it('an answer the host refuses leaves it asked; a taken one settles it — once', async () => {
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      const answered = asks.ask('conv-1', ask(), {
        signal: new AbortController().signal,
        refuse: (answer) => (answer.optionId === 'install' && answer.digest !== 'digest-r' ? 'nobody saw what it may do' : null),
      });
      const bare = await service.respond({ conversationId: 'conv-1', itemId: 'host-1', kind: 'permission', optionId: 'install', by: 'old-phone' });
      expect(bare).toMatchObject({ ok: false, error: { code: 'host_ask_refused', message: 'nobody saw what it may do' } });
      await expect(settled(answered)).resolves.toBe('still asked');
      const first = await service.respond({ conversationId: 'conv-1', itemId: 'host-1', kind: 'permission', optionId: 'decline', by: 'desktop' });
      const second = await service.respond({ conversationId: 'conv-1', itemId: 'host-1', kind: 'permission', optionId: 'install', digest: 'digest-r', by: 'phone' });
      expect(first).toMatchObject({ ok: true, value: { accepted: true } });
      expect(second).toMatchObject({ ok: true, value: { accepted: false, settlement: { resolvedBy: 'desktop' } } });
      await expect(answered).resolves.toMatchObject({ optionId: 'decline', by: 'desktop' });
    });

    it("the host's clock runs out: withdrawn, cancelled where it was shown, and a late answer is told so", async () => {
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      const clock = new AbortController();
      const answered = asks.ask('conv-1', ask(), { signal: clock.signal });
      clock.abort();
      await expect(answered).resolves.toBe('withdrawn');
      const late = await service.respond({ conversationId: 'conv-1', itemId: 'host-1', kind: 'permission', optionId: 'install', digest: 'digest-r', by: 'phone' });
      expect(late).toMatchObject({ ok: true, value: { accepted: false, settlement: { itemId: 'host-1', state: 'cancelled' } } });
    });

    it('no such session here: unavailable (the host asks in its window alone)', async () => {
      await expect(asks.ask('conv-nope', ask(), { signal: new AbortController().signal })).resolves.toBe('unavailable');
    });

    it('one the archive brings back pending, asked by a process that is gone: over, never shown as still asked', async () => {
      // 10-06 A/B: B restarted with an ask out; the timeline came back from its archive with it pending and nothing here asking it.
      const { timeline } = makeTimeline();
      timeline.syncPendingRequests([ask('host-old')]);
      service.setSessionTimelineFactory(async () => timeline);
      const snapshot = await service.snapshot({ conversationId: 'conv-1' });
      expect(snapshot).toMatchObject({ ok: true, value: { settlements: [{ itemId: 'host-old', state: 'cancelled' }] } });
    });

    const archivedQuestion = (state: Settlement['state'] = 'pending'): Settlement => ({
      itemId: 'agent-question:11111111-1111-4111-8111-111111111111', kind: 'question', title: 'Which Node?',
      questions: [{ question: 'Which Node?', multiSelect: false, options: [{ optionId: 'PATH', name: 'PATH' }] }],
      origin: { source: 'agent-question', payload: { sourceLink: 'gugu-chat://22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333' } },
      state, optionId: state === 'resolved' ? '[{"selected":["PATH"]}]' : null, resolvedBy: null, resolvedAt: null,
    });

    it('restores an archived unanswered agent card without granting or answering anything', async () => {
      const fake = makeTimeline(); const card = archivedQuestion(); fake.put(card);
      service.setSessionTimelineFactory(async () => fake.timeline);
      expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true, value: { settlements: [{ state: 'pending' }] } });
      expect(state.questionSend).not.toHaveBeenCalled();
      const answer = { conversationId: 'conv-1', itemId: card.itemId, kind: 'question' as const, answers: [{ selected: ['PATH'] }], by: 'desktop' };
      expect(await service.respond(answer)).toMatchObject({ ok: true, value: { accepted: true } });
      await vi.waitFor(() => expect(state.questionSend).toHaveBeenCalledTimes(1));
      expect(state.questionSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'conv-1', projectId: 'proj-1', clientMessageId: card.itemId.slice('agent-question:'.length), text: expect.stringContaining('"reply_to_message_id":"33333333-3333-4333-8333-333333333333"') }));
      expect(await service.respond(answer)).toMatchObject({ ok: true, value: { accepted: false } });
      expect(state.questionSend).toHaveBeenCalledTimes(1);
    });

    it('restores an unanswered card from durable state even when no transcript archive was ever written', async () => {
      const card = archivedQuestion();
      persistedQuestions.set('conv-1', [card]);
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true, value: { settlements: [expect.objectContaining({ itemId: card.itemId, state: 'pending' })] } });
      expect(state.questionSend).not.toHaveBeenCalled();
      service.resetSessionTimelineService();
      service.setSessionTimelineFactory(async () => makeTimeline().timeline);
      expect(await service.snapshot({ conversationId: 'conv-1' })).toMatchObject({ ok: true, value: { settlements: [expect.objectContaining({ itemId: card.itemId, state: 'pending' })] } });
      expect(await service.respond({ conversationId: 'conv-1', itemId: card.itemId, kind: 'question', answers: [{ selected: ['PATH'] }], by: 'desktop' })).toMatchObject({ ok: true, value: { accepted: true } });
      expect(persistedQuestions.get('conv-1')?.[0].state).toBe('resolved');
      await vi.waitFor(() => expect(state.questionSend).toHaveBeenCalledTimes(1));
    });

    it('replays only versioned resolved cards through the same outbox id; cancelled and legacy resolved cards stay closed', async () => {
      const fake = makeTimeline(); const pending = archivedQuestion();
      const payload = { sourceLink: (pending.origin!.payload as { sourceLink: string }).sourceLink, deliveryVersion: 1, answerMessageId: '44444444-4444-4444-8444-444444444444' };
      fake.put({ ...archivedQuestion('resolved'), origin: { source: 'agent-question', payload } });
      fake.put({ ...archivedQuestion('resolved'), itemId: 'agent-question:55555555-5555-4555-8555-555555555555' });
      fake.put({ ...archivedQuestion('cancelled'), itemId: 'agent-question:66666666-6666-4666-8666-666666666666', origin: { source: 'agent-question', payload } });
      service.setSessionTimelineFactory(async () => fake.timeline);
      await service.snapshot({ conversationId: 'conv-1' });
      await vi.waitFor(() => expect(state.questionSend).toHaveBeenCalledTimes(1));
      expect(state.questionSend).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId: payload.answerMessageId, text: expect.stringContaining('"selected":["PATH"]') }));
      expect(fake.timeline.getSnapshot().settlements.map(s => s.state)).toEqual(['resolved', 'resolved', 'cancelled']);
    });

    it('one still asked here when its timeline reopens stays asked', async () => {
      // The same process: its viewers left (the entry was archived and dropped), the ask is still out.
      const { timeline } = makeTimeline();
      timeline.syncPendingRequests([ask('host-live')]);
      service.setSessionTimelineFactory(async () => timeline);
      const clock = new AbortController();
      const answered = asks.ask('conv-1', ask('host-live'), { signal: clock.signal });
      await service.snapshot({ conversationId: 'conv-1' });
      await expect(settled(answered)).resolves.toBe('still asked');
      expect(timeline.getSnapshot().settlements.map((one) => [one.itemId, one.state])).toEqual([['host-live', 'pending']]);
      clock.abort();
      await answered;
    });
  });

});

/**
 * 手机点开附件卡(#7193):机器只读这条会话**真的**打开过的文件,依据是宿主记下的那一份(sessions/session-outputs.ts)。
 * 判据喂记录 + 临时文件;阴控是同一个目录里、记录里没有的文件 —— 必须被拒。
 */
const { mkdtempSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

describe('readOpenedFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opened-file-'));
  const report = join(dir, 'report.html');
  const other = join(dir, 'secret.txt');
  writeFileSync(report, '<h1>汇报</h1>');
  writeFileSync(other, 'not for the phone');

  beforeEach(() => {
    openedOutputs.clear();
  });

  it('打开过的文件:按块读出原字节', async () => {
    openedOutputs.set('conv-1', [{ kind: 'file', path: report }]);
    const result = await service.readOpenedFile({ conversationId: 'conv-1', path: report, offset: 0, length: 1024 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.value.data, 'base64').toString('utf8')).toBe('<h1>汇报</h1>');
    expect(result.value.size).toBe(Buffer.byteLength('<h1>汇报</h1>'));
  });

  it('记录里没打开过的文件:拒,哪怕它就在同一个目录里;别的会话打开过的也不算', async () => {
    openedOutputs.set('conv-1', [{ kind: 'file', path: report }]);
    openedOutputs.set('conv-2', [{ kind: 'file', path: other }]);
    const result = await service.readOpenedFile({ conversationId: 'conv-1', path: other, offset: 0, length: 1024 });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_opened' } });
  });

  it('打开过、后来被删了:如实说文件不在了', async () => {
    const gone = join(dir, 'gone.html');
    openedOutputs.set('conv-1', [{ kind: 'file', path: gone }]);
    const result = await service.readOpenedFile({ conversationId: 'conv-1', path: gone, offset: 0, length: 1024 });
    expect(result).toMatchObject({ ok: false, error: { code: 'file_missing' } });
  });

  it('打开的是一个目录:不读', async () => {
    openedOutputs.set('conv-1', [{ kind: 'file', path: dir }]);
    const result = await service.readOpenedFile({ conversationId: 'conv-1', path: dir, offset: 0, length: 1024 });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_a_file' } });
  });
});
