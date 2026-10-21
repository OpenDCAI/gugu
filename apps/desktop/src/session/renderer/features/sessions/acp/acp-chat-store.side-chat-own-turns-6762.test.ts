// @vitest-environment jsdom
/**
 * #6762 —— 侧边聊天挂上会话之前就从这个视图开出来、而且已经答完的那一轮,挂上之后必须画出来。
 *
 * ## 修复前是什么样(mac1 真 Electron,2026-09-29)
 *
 * 聊天面挂上会话之前发的话,运行时收到那一刻就判准入(空闲就开轮)。挂上时 store 把「引擎里已有几轮」
 * 记作「分叉带来的来源前缀」、此后一律切掉 —— 挂上之前就答完的那一轮于是被当成来源前缀整轮藏掉:
 * 运行时里有 `OK-1318`,屏上什么都没有(`_transientHistoryPrefixCount: 1`)。
 *
 * ## 现在的合同
 *
 * 侧边聊天只画在这条分叉里开出来的回合;来源历史只可能经分叉启动时的重放进来,而重放的回合没有
 * `startedAt`(session-core `turn.ts`)。按身份认,❌ 按挂上那一刻的条数切。
 *
 * ## 判据能判假吗
 *
 * 能:把 `_visibleHistoryTurns` 换回「挂上时记下条数、之后切掉那么多条」,两条用例都红 ——
 * 第二条正是 mac1 上那一格(没有重放、只有那一轮)。
 */
import { describe, expect, it, vi } from 'vitest';
import { runInAction, when } from 'mobx';
import type { TranscriptTurn } from '@gugu/session-core/acp';

let nextSession: unknown = null;
vi.mock('@renderer/lib/acp/acp-live-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/acp/acp-live-session')>()),
  AcpLiveSession: {
    create: vi.fn(async () => nextSession),
  },
}));
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({ queuePrompt: vi.fn() }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

type StoreModule = typeof import('./acp-chat-store');

// 桥必须在模块图加载之前就位(同 acp-chat-store.session-absent.test.ts 的先例与理由)。
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
  return {
    current: () => initial,
    onChange: () => () => {},
    ready: Promise.resolve(),
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

/** 重放出来的来源回合:没有 startedAt(重放没有真实时钟)。 */
const replayed = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [] }) as unknown as TranscriptTurn;
/** 在这条分叉里开出来的回合:开轮那一刻打上墙钟。 */
const own = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', startedAt: 1_790_000_000_000 + seq, items: [] }) as unknown as TranscriptTurn;

function sessionWithHistory(turns: TranscriptTurn[]) {
  return {
    agents: replica([] as unknown[]),
    sessionState: replica<Record<string, unknown>>(readyState),
    activeTurn: replica(null),
    plan: replica(null),
    draft: replica(null),
    terminals: replica([] as unknown[]),
    config: replica({}),
    getHistory: vi.fn(async () => ({ success: true as const, data: { turns, nextCursor: null } })),
    dispose: () => {},
  };
}

let seq = 0;
/** 走真的挂上路径(`reattachAfterHostReload` = 只附着、不带启动输入),引擎那侧给定这份历史。 */
async function attachSideChat(turns: TranscriptTurn[]) {
  seq += 1;
  const store = new AcpChatStore(`conv-6762-${seq}`, 'proj-1', {
    id: `side-chat:6762-${seq}`,
    forkFromProviderSessionId: 'provider-source',
  });
  nextSession = sessionWithHistory(turns);
  runInAction(() => {
    (store as unknown as { _bootstrapped: boolean })._bootstrapped = true;
  });
  store.reattachAfterHostReload();
  // 挂上路径走完 = 句柄落到 store 上(session 是 mobx 观察值):等它,后面的读数才算数。
  await when(() => store.session !== null);
  return store;
}

const shownIds = (store: InstanceType<StoreModule['AcpChatStore']>) =>
  store.chatState.transcript.state.committedTurns.map((turn) => turn.id);

describe('#6762 侧边聊天画哪几轮', () => {
  it('分叉重放进来的来源历史不画,挂上之前就答完的那一轮照画', async () => {
    const store = await attachSideChat([replayed('src-0', 0), replayed('src-1', 1), own('mine-2', 2)]);
    expect(store.isTransient, '被测对象必须是侧边聊天').toBe(true);
    expect(shownIds(store)).toEqual(['mine-2']);
  });

  it('没有重放的家(claude / codex 分叉):挂上时引擎里唯一那一轮是自己的,不许当成来源前缀藏掉', async () => {
    const store = await attachSideChat([own('mine-0', 0)]);
    expect(shownIds(store), '问了、答了,屏上什么都没有 —— mac1 上那一格').toEqual(['mine-0']);
  });
});
