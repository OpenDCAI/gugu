// @vitest-environment jsdom
/**
 * 不在屏上、也不在最近看过的那几条里的会话,放掉转录(`releaseTranscript` / acp-chat-transcript-keep)。
 *
 * 钉的是:放掉时转录真的空了、活会话照挂;放掉期间提交一轮不去对账(否则又攒回来);
 * 回来时照首次打开那样重读;正在屏上 / 还在加载的不放;只放最近看过的那几条之外的。
 *
 * 桥与动态 import 的写法照 `acp-chat-store.session-absent.test.ts`(那里写了为什么必须这样)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { ChatView } from '@renderer/lib/chat/chat-transcript';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

type StoredPage = { turns: TranscriptTurn[]; originTurnIds: string[]; nextCursor: number | null };
let storedPage: StoredPage | null = null;
let storedReads = 0;

Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: (channel: string) => {
      if (channel !== 'sessions.getStoredHistory') return Promise.resolve([]);
      storedReads += 1;
      return Promise.resolve(storedPage);
    },
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');
const { KEPT_HIDDEN_TRANSCRIPTS, forgetTranscriptShown, noteTranscriptShown } = await import(
  './acp-chat-transcript-keep'
);

const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [] }) as unknown as TranscriptTurn;

type Internals = {
  session: unknown;
  _bootstrapped: boolean;
  _storedHistoryTurns: TranscriptTurn[];
  _refreshHistory: () => Promise<void>;
};

let n = 0;
/** 一条已经开过场、转录在手的会话:库里两轮,画在屏上。 */
function openedStore(session: unknown) {
  n += 1;
  const store = new AcpChatStore(`conv-release-${n}`, 'proj-1');
  const internals = store as unknown as Internals;
  const stored = [turn('s0', 0), turn('s1', 1)];
  internals._bootstrapped = true;
  internals.session = session;
  internals._storedHistoryTurns = stored;
  store.chatState.transcript.history.seed(stored);
  store.historyLoading = false;
  return { store, internals };
}

const committedIds = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map((t) => t.id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  storedPage = null;
  storedReads = 0;
});

describe('放掉转录', () => {
  it('转录与库里那页都放掉,回来前先是「加载中」;活会话照挂', () => {
    const session = { getHistory: vi.fn() };
    const { store, internals } = openedStore(session);

    store.releaseTranscript();

    expect(committedIds(store)).toEqual([]);
    expect(internals._storedHistoryTurns).toEqual([]);
    expect(store.historyLoading).toBe(true);
    expect(internals.session).toBe(session);
  });

  it('还在跑的那一轮留着 —— 它提交时旁听口要读它', () => {
    const { store } = openedStore({ getHistory: vi.fn() });
    store.chatState.transcript.activeTurn.set(turn('live', 2));

    store.releaseTranscript();

    expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('live');
  });

  it('放掉期间提交一轮:不对账,库与引擎都不读', async () => {
    const session = { getHistory: vi.fn() };
    const { store, internals } = openedStore(session);
    store.releaseTranscript();

    await internals._refreshHistory();

    expect(storedReads).toBe(0);
    expect(session.getHistory).not.toHaveBeenCalled();
    expect(committedIds(store)).toEqual([]);
  });

  it('正挂在屏上、或者还在加载的,不放', () => {
    const shownOne = openedStore({ getHistory: vi.fn() }).store;
    shownOne.bindView({} as ChatView);
    shownOne.releaseTranscript();
    expect(committedIds(shownOne)).toEqual(['s0', 's1']);

    const loading = openedStore({ getHistory: vi.fn() }).store;
    loading.historyLoading = true;
    loading.releaseTranscript();
    expect(committedIds(loading)).toEqual(['s0', 's1']);
  });
});

describe('回来时重读', () => {
  it('活会话还挂着:走重挂那条路(只附着,不再建立)', () => {
    const { store } = openedStore({ getHistory: vi.fn() });
    store.releaseTranscript();
    const reattach = vi.spyOn(store, 'reattachAfterHostReload').mockImplementation(() => {});

    store.bootstrap();

    expect(reattach).toHaveBeenCalledTimes(1);
  });

  it('没有活会话(宿主停了它):只重读库里那页,停着的照样停着', async () => {
    const { store, internals } = openedStore(null);
    store.releaseTranscript();
    storedPage = { turns: [turn('s0', 0), turn('s1', 1), turn('s2', 2)], originTurnIds: [], nextCursor: null };

    store.bootstrap();
    await flush();
    await flush();

    expect(storedReads).toBe(1);
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.historyLoading).toBe(false);
    expect(internals.session).toBeNull();
  });
});

describe('只放最近看过的那几条之外的', () => {
  type Fake = { isTransient: boolean; releaseTranscript: ReturnType<typeof vi.fn> };
  const made: Fake[] = [];
  const fake = (isTransient = false): Fake => {
    const store = { isTransient, releaseTranscript: vi.fn() };
    made.push(store);
    return store;
  };
  afterEach(() => {
    for (const store of made.splice(0)) forgetTranscriptShown(store as never);
  });

  it(`当前这条 + 最近 ${KEPT_HIDDEN_TRANSCRIPTS} 条留着,再往前的放掉`, () => {
    const stores = Array.from({ length: KEPT_HIDDEN_TRANSCRIPTS + 3 }, () => fake());
    for (const store of stores) noteTranscriptShown(store as never);

    const released = stores.map((store) => store.releaseTranscript.mock.calls.length > 0);
    expect(released).toEqual(stores.map((_, i) => i < 2));
  });

  it('切回一条旧的:它排到最前,挤出去的是此刻最久没看的那条', () => {
    const stores = Array.from({ length: KEPT_HIDDEN_TRANSCRIPTS + 1 }, () => fake());
    for (const store of stores) noteTranscriptShown(store as never);
    expect(stores.every((store) => store.releaseTranscript.mock.calls.length === 0)).toBe(true);

    noteTranscriptShown(stores[0] as never);
    noteTranscriptShown(fake() as never);

    expect(stores[1]!.releaseTranscript).toHaveBeenCalled();
    expect(stores[0]!.releaseTranscript).not.toHaveBeenCalled();
  });

  it('侧边聊天不进名单 —— 放掉它就没了', () => {
    const side = fake(true);
    noteTranscriptShown(side as never);
    for (let i = 0; i < KEPT_HIDDEN_TRANSCRIPTS + 2; i += 1) noteTranscriptShown(fake() as never);

    expect(side.releaseTranscript).not.toHaveBeenCalled();
  });
});
