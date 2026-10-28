// @vitest-environment jsdom
/**
 * 2026-10-28 主人撞到:子会话的适配器退出后按 `resume-unspecified` 接上,引擎不重放旧轮次 ⇒ 引擎那页空、库里有。
 * 「spawned 子会话 ready + 空闲 + transcript 为空」那道完整性检查只看引擎那页,于是每次打开都报
 * 「ACP transcript is empty」,点重试是同一个判断,次次都红。
 *
 * 判据:库里有 ⇒ 照库上屏、不报错;库里也空 ⇒ 照旧报(#4949 那个空白面板的形状还要拦住)。
 *
 * ## 判据能判假吗
 *
 * 能:去掉条件里的 `this._storedBaseSeq === null`,第一条用例当场红(mac1 实测,输出贴在 PR 里)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const records = vi.hoisted(() => new Map<string, Partial<Session>>());
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: {
    get: (id: string) =>
      records.has(id) ? { sessions: new Map([[id, { data: records.get(id) }]]) } : undefined,
  },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
let liveSession: unknown = null;
vi.mock('@renderer/lib/acp/acp-live-session', async (original) => ({
  ...(await original<typeof import('@renderer/lib/acp/acp-live-session')>()),
  AcpLiveSession: { create: vi.fn(async () => liveSession) },
}));

type StoredPage = { turns: TranscriptTurn[]; originTurnIds: string[]; nextCursor: number | null };
let storedPage: StoredPage | null = null;

Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    // 与库的读法同一套语义:带 `fromSeq` 的是开场后补读的尾巴,只回那之后的几轮。
    invoke: (channel: string, args?: { fromSeq?: number }) => {
      if (channel !== 'sessions.getStoredHistory' || !storedPage) return Promise.resolve(channel === 'sessions.getStoredHistory' ? storedPage : []);
      const fromSeq = args?.fromSeq;
      if (fromSeq === undefined) return Promise.resolve(storedPage);
      const turns = storedPage.turns.filter((t) => t.seq >= fromSeq);
      return Promise.resolve({ turns, originTurnIds: [], nextCursor: null });
    },
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');

const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [] }) as unknown as TranscriptTurn;

/** 接上之后的引擎:ready、空闲、没有排队,历史一轮都没有(`resume-unspecified` 不重放)。 */
function resumedEmptyEngine() {
  const replica = <T>(value: T) => ({ current: () => value, onChange: () => () => {}, onGone: () => () => {}, ready: Promise.resolve() });
  return {
    agents: replica([]), config: replica({}), plan: replica(null), terminals: replica([]), draft: replica(null),
    activeTurn: replica(null),
    sessionState: replica({ lifecycle: 'ready', isGenerating: false, queuedPrompts: [], pendingPermissions: [] }),
    dispose() {},
    getHistory: () => Promise.resolve({
      success: true as const,
      data: { turns: [], nextCursor: null, cursor: { epoch: 'runtime', seq: 0 }, reset: false, count: 0 },
    }),
  };
}

type Internals = { _runBootstrap: (options: { attachOnly: boolean }) => Promise<void> };

let n = 0;
function spawnedChild() {
  n += 1;
  const id = `child-${n}`;
  records.set(id, { id, providerId: 'claude', spawnedBySessionId: 'parent-1', firstUtterance: 'review the migration' } as Partial<Session>);
  const store = new AcpChatStore(id, 'proj-1');
  return { store, internals: store as unknown as Internals };
}

const committedIds = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map((t) => t.id);

beforeEach(() => {
  storedPage = null;
  liveSession = resumedEmptyEngine();
});
afterEach(() => {
  records.clear();
  vi.restoreAllMocks();
});

describe('AcpChatStore: a resumed spawned child whose engine replays nothing', () => {
  it('opens from the stored turns when the engine history is empty but the store has them', async () => {
    storedPage = { turns: [turn('s0', 0), turn('s1', 1), turn('s2', 2)], originTurnIds: [], nextCursor: null };
    const { store, internals } = spawnedChild();

    await internals._runBootstrap({ attachOnly: true });

    expect(store.loadError).toBeNull();
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    store.dispose();
  });

  it('❌ negative: the store is empty too — still reported as an empty transcript', async () => {
    storedPage = { turns: [], originTurnIds: [], nextCursor: null };
    const { store, internals } = spawnedChild();

    await internals._runBootstrap({ attachOnly: true });

    expect(store.loadError?.message).toContain('ACP transcript is empty');
    expect(committedIds(store)).toEqual([]);
    store.dispose();
  });
});
