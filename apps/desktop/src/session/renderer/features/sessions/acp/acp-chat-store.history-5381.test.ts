// @vitest-environment jsdom
/**
 * #5381 评审 #2 / #3 / #4 —— 界面这一层的**接线**。
 *
 * 这里钉的是 store 有没有把纯合成规则接对:
 * 每轮对账只按改动游标取新增 / 改过的那几轮(@@@history-change-cursor,❌ 一页页重取、❌ 从开场那页第一行重读库)、
 * 开场时补读的那几行只出一次、重挂之后状态有没有清、在途请求回来时对不上号有没有丢弃。
 *
 * 桥与动态 import 的写法照 `acp-chat-store.session-absent.test.ts`(那里写了为什么必须这样)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { HistoryCursor } from '@gugu/session-core/acp/client';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
let resumeSession: unknown = null;
vi.mock('@renderer/lib/acp/acp-live-session', async (original) => ({
  ...(await original<typeof import('@renderer/lib/acp/acp-live-session')>()),
  AcpLiveSession: { create: vi.fn(async () => resumeSession) },
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
    invoke: (channel: string) =>
      Promise.resolve(channel === 'sessions.getStoredHistory' ? storedPage : []),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');

const turn = (id: string, seq: number): TranscriptTurn =>
  ({ id, seq, initiator: 'user', items: [] }) as unknown as TranscriptTurn;

/**
 * 与运行时 `getHistory` 同一套语义:取 seq < before 的最后 limit 条,由旧到新;取满才给游标。`changedSince` 给了就只回
 * 改动游标之后新增 / 改过的回合。每一轮的改动记号 = 它出现(或被改)的那一次的序号,开头那 count 轮是 1..count。
 */
function fakeRuntime(count: number) {
  const committed = Array.from({ length: count }, (_, seq) => turn(`r${seq}`, seq));
  const revs = committed.map((_, index) => index + 1);
  let rev = count;
  let epoch = 'runtime';
  const replica = <T>(value: T) => ({ current: () => value, onChange: () => () => {}, onGone: () => () => {}, ready: Promise.resolve() });
  const calls: Array<{ before?: number; changedSince?: HistoryCursor }> = [];
  return {
    calls,
    committed,
    restart() { epoch = 'restarted-runtime'; },
    append(next: TranscriptTurn) { committed.push(next); revs.push(++rev); },
    revise(index: number, next: TranscriptTurn) { committed[index] = next; revs[index] = ++rev; },
    session: {
      agents: replica([]), config: replica({}), plan: replica(null), terminals: replica([]), draft: replica(null),
      activeTurn: replica(null),
      sessionState: replica({ lifecycle: 'ready', isGenerating: false, queuedPrompts: [], pendingPermissions: [] }),
      dispose() {},
      getHistory: (before: number | undefined, limit = 50, changedSince?: HistoryCursor) => {
        calls.push({ before, changedSince });
        const head = { cursor: { epoch, seq: rev }, reset: false, count: committed.length };
        if (changedSince !== undefined) {
          if (changedSince.epoch !== epoch) return Promise.resolve({ success: true as const, data: { turns: [], nextCursor: null, ...head, reset: true } });
          return Promise.resolve({ success: true as const, data: { turns: committed.filter((_, i) => revs[i]! > changedSince.seq), nextCursor: null, ...head } });
        }
        const filtered = before === undefined ? committed : committed.filter((t) => t.seq < before);
        const page = filtered.slice(-limit);
        const nextCursor = page.length === limit ? page[0]!.seq : null;
        return Promise.resolve({ success: true as const, data: { turns: page, nextCursor, ...head } });
      },
    },
  };
}

type Internals = {
  session: unknown;
  _storedHistoryTurns: TranscriptTurn[];
  _storedOrigins: string[];
  _storedBaseSeq: number | null;
  _storedBootstrapMaxSeq: number;
  _runtimeReplayEndSeq: number;
  _runtimeCursor: HistoryCursor | null;
  _runtimeCount: number;
  _runtimeTurns: TranscriptTurn[];
  _runtimeWindowStartSeq: number;
  _olderHistoryTurns: TranscriptTurn[];
  _olderCursor: number | null | undefined;
  _olderSource: 'stored' | 'runtime';
  _historyGeneration: number;
  _reloadStoredTail: (generation: number) => Promise<void>;
  _refreshHistory: () => Promise<void>;
  _runBootstrap: (options: { attachOnly: boolean }) => Promise<void>;
  _resetHistoryState: () => void;
  _applyDraftSnapshot: (draft: null) => void;
  _pendingDraftRev: number | null;
  loadOlderHistory: () => Promise<TranscriptTurn[]>;
};

let n = 0;
function makeStore() {
  n += 1;
  const store = new AcpChatStore(`conv-5381-${n}`, 'proj-1');
  return { store, internals: store as unknown as Internals };
}

const committedIds = (store: InstanceType<typeof AcpChatStore>) =>
  store.chatState.transcript.state.committedTurns.map((t) => t.id);

beforeEach(() => {
  storedPage = null;
});
afterEach(() => vi.restoreAllMocks());

describe('lazy tool pictures after the host closes the runtime', () => {
  it('reads the persisted original turn without restarting the stopped runtime', async () => {
    const { store, internals } = makeStore();
    internals.session = null;
    internals._runtimeTurns = [{ ...turn('runtime:turn:2', 2), items: [
      { kind: 'mcp-tool-call', id: 'runtime:turn:2:tool:pic', seq: 0, toolCallId: 'pic', tool: 'screenshot',
        title: 'Screenshot', status: 'done', imageRefs: [{ mimeType: 'image/png', chars: 4 }] },
    ] }];
    const bridge = window.electronAPI;
    if (!bridge) throw new Error('test desktop bridge missing');
    const invoke = vi.spyOn(bridge, 'invoke').mockResolvedValue({
      ok: true, image: { mimeType: 'image/png', data: 'aGV5' },
    });
    expect(await store.resolveToolImage('runtime:turn:2:tool:pic', 0)).toBe('data:image/png;base64,aGV5');
    expect(invoke).toHaveBeenCalledWith('sessions.getStoredToolImage', {
      sessionId: store.sessionId, originTurnId: 'runtime:turn:2', itemId: 'runtime:turn:2:tool:pic', index: 0,
    });
    expect(internals.session).toBeNull();
    store.dispose();
  });
});

describe('#7304 原地回退后的历史对账', () => {
  function setup() {
    const { store, internals } = makeStore();
    const turns: TranscriptTurn[] = [0, 1, 2].map((seq) => ({ ...turn(`s${seq}`, seq), items: [
      { kind: 'message' as const, id: `m${seq}`, seq: 0, role: 'user' as const, text: `text-${seq}`, revertAnchor: `native-${seq}` },
    ] }));
    store.chatState.transcript.history.seed(turns);
    internals._storedHistoryTurns = turns;
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 2;
    const session = {
      setPromptDraft: vi.fn(async () => ({ success: true as const, data: undefined })),
      sessionState: { current: () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: false }) },
      getHistory: vi.fn(async () => ({ success: true as const, data: { turns: turns.slice(0, 1), nextCursor: null, cursor: { epoch: 'runtime', seq: 1 }, reset: false, count: 1 } })),
      revertSession: vi.fn(async () => {
        storedPage = { turns: turns.slice(0, 1), originTurnIds: ['s0'], nextCursor: null };
        return { success: true as const, data: { providerSessionId: 'unchanged' } };
      }),
      sendPrompt: vi.fn(async (_input: unknown) => ({ success: true as const, data: undefined })),
    };
    internals.session = session;
    return { store, internals, session, turns };
  }

  it('裁掉缓存中的未来、恢复原文,后续对账也不复活旧消息', async () => {
    const { store, internals, session } = setup();
    await store.revertMessage('m1');
    expect(session.revertSession).toHaveBeenCalledWith('native-1');
    expect(committedIds(store)).toEqual(['s0']);
    expect(store.draftText).toBe('text-1');
    expect(store.reverting).toBe(false);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0']);
  });

  it('底层拒绝时保留当前显示和草稿', async () => {
    const { store, session } = setup();
    store.setDraftText('draft');
    session.revertSession.mockRejectedValueOnce(new Error('native refusal'));
    await store.revertMessage('m1');
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.draftText).toBe('draft');
    expect(store.reverting).toBe(false);
  });

  it('回退前发出的旧历史请求晚到时不覆盖新前缀', async () => {
    const { store, internals, session, turns } = setup();
    storedPage = { turns, originTurnIds: turns.map((t) => t.id), nextCursor: null };
    let finish!: (page: { success: true; data: { turns: TranscriptTurn[]; nextCursor: null; cursor: HistoryCursor; reset: boolean; count: number } }) => void;
    session.getHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stale = internals._refreshHistory();
    await store.revertMessage('m1');
    finish({ success: true, data: { turns, nextCursor: null, cursor: { epoch: 'runtime', seq: 3 }, reset: false, count: 3 } });
    await stale;
    expect(committedIds(store)).toEqual(['s0']);
  });

  it('编辑和取消都不调用原生回退,也不改后续历史或主输入框草稿', () => {
    const { store, session } = setup();
    store.setDraftText('main composer draft');
    store.beginMessageEdit('m1');
    expect(store.messageEdit).toEqual({ itemId: 'm1', text: 'text-1' });
    store.changeMessageEdit('m1', 'edited B');
    expect(store.messageEdit?.text).toBe('edited B');
    store.cancelMessageEdit('m1');
    expect(store.messageEdit).toBeNull();
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(store.draftText).toBe('main composer draft');
    expect(session.revertSession).not.toHaveBeenCalled();
    expect(session.sendPrompt).not.toHaveBeenCalled();
  });

  it('发送编辑先原地回退再发送修改内容,保留原附件和主输入框草稿', async () => {
    const { store, session, turns } = setup();
    Object.assign(turns[1]!.items[0]!, { attachments: [{ id: 'image-1', name: 'photo.png', mimeType: 'image/png' }] });
    store.setDraftText('main composer draft');
    store.beginMessageEdit('m1');
    store.changeMessageEdit('m1', 'edited B');
    await store.sendMessageEdit('m1');
    expect(session.revertSession).toHaveBeenCalledExactlyOnceWith('native-1');
    expect(session.sendPrompt).toHaveBeenCalledExactlyOnceWith({ text: 'edited B', origin: 'manual',
      attachments: [{ type: 'attachment', id: 'image-1', name: 'photo.png', mimeType: 'image/png' }] });
    expect(session.revertSession.mock.invocationCallOrder[0]).toBeLessThan(session.sendPrompt.mock.invocationCallOrder[0]!);
    expect(committedIds(store)).toEqual(['s0']);
    expect(store.messageEdit).toBeNull();
    expect(store.draftText).toBe('main composer draft');
  });

  it('原生回退拒绝后保留编辑内容和当前对话,可重新点发送', async () => {
    const { store, session } = setup();
    store.beginMessageEdit('m1'); store.changeMessageEdit('m1', 'edited B');
    session.revertSession.mockRejectedValueOnce(new Error('native refusal'));
    await store.sendMessageEdit('m1');
    expect(store.messageEdit?.text).toBe('edited B');
    expect(committedIds(store)).toEqual(['s0', 's1', 's2']);
    expect(session.sendPrompt).not.toHaveBeenCalled();
    await store.sendMessageEdit('m1');
    expect(session.sendPrompt).toHaveBeenCalledExactlyOnceWith({ text: 'edited B', origin: 'manual' });
  });

  it('编辑发送引起的运行时草稿清空不会擦掉已同步的主输入框草稿', async () => {
    const { store, internals, session } = setup();
    store.setDraftText('already synced draft');
    internals._pendingDraftRev = null;
    session.sendPrompt.mockImplementation(async () => {
      internals._applyDraftSnapshot(null);
      return { success: true, data: undefined };
    });
    store.beginMessageEdit('m1'); store.changeMessageEdit('m1', 'edited B');
    await store.sendMessageEdit('m1');
    expect(store.draftText).toBe('already synced draft');
  });

  it('发送时重新检查忙态与空文本,双击发送只回退一次', async () => {
    const { store, session } = setup();
    store.beginMessageEdit('m1'); store.changeMessageEdit('m1', ' ');
    await store.sendMessageEdit('m1');
    expect(session.revertSession).not.toHaveBeenCalled();
    store.changeMessageEdit('m1', 'edited B');
    session.sessionState.current = () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: true });
    await store.sendMessageEdit('m1');
    expect(session.revertSession).not.toHaveBeenCalled();
    session.sessionState.current = () => ({ lifecycle: 'ready', queuedPrompts: [], pendingPermissions: [], isGenerating: false });
    const first = store.sendMessageEdit('m1');
    await store.sendMessageEdit('m1');
    await first;
    expect(session.revertSession).toHaveBeenCalledTimes(1);
    expect(session.sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('@@@history-change-cursor:每提交一轮只取改动游标之后的那几轮', () => {
  function opened(count: number, replayEnd: number) {
    const { store, internals } = makeStore();
    const runtime = fakeRuntime(count);
    internals.session = runtime.session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedOrigins = ['old'];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = replayEnd;
    internals._runtimeCursor = { epoch: 'runtime', seq: count };
    internals._runtimeCount = count;
    return { store, internals, runtime };
  }

  it('新提交的一轮:问一次(带游标),只并进这一轮;❌ 一页页重取、❌ 重读库', async () => {
    const { store, internals, runtime } = opened(250, 250);
    runtime.append(turn('r250', 250));
    let storedReads = 0;
    storedPage = null;
    const invoke = (window as unknown as { electronAPI: { invoke: (c: string) => Promise<unknown> } }).electronAPI.invoke;
    (window as unknown as { electronAPI: { invoke: (c: string) => Promise<unknown> } }).electronAPI.invoke = (channel: string) => {
      if (channel === 'sessions.getStoredHistory') storedReads += 1;
      return invoke(channel);
    };
    try {
      await internals._refreshHistory();
    } finally {
      (window as unknown as { electronAPI: { invoke: (c: string) => Promise<unknown> } }).electronAPI.invoke = invoke;
    }
    expect(runtime.calls).toEqual([{ before: undefined, changedSince: { epoch: 'runtime', seq: 250 } }]);
    expect(storedReads).toBe(0);
    expect(committedIds(store)).toEqual(['s0', 'r250']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 251 });
  });

  /** 修复前(#5381):前缀记 100,对账拿到的窗口仍是 100 条,切掉 100 条是空的,刚讲完的一轮从屏幕上消失。 */
  it('重放满 100 轮后再聊一轮,对账之后新的一轮在屏幕上', async () => {
    const { store, internals, runtime } = opened(100, 100);
    runtime.append(turn('r100', 100));
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0', 'r100']);
  });

  it('分界之后的一轮被改了(迟到的尾巴):换掉手里那一份,❌ 再加一份', async () => {
    const { store, internals, runtime } = opened(5, 5);
    runtime.append(turn('r5', 5));
    await internals._refreshHistory();
    runtime.revise(5, { ...turn('r5', 5), endedAt: 1 } as TranscriptTurn);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0', 'r5']);
    expect(internals._runtimeTurns[0]).toMatchObject({ id: 'r5', endedAt: 1 });
  });

  it('分界之前的一轮被改了(后台命令的终态):只重读它在库里的那一行', async () => {
    const { store, internals, runtime } = opened(5, 5);
    internals._storedOrigins = ['r3'];
    runtime.revise(3, { ...turn('r3', 3), endedAt: 2 } as TranscriptTurn);
    storedPage = { turns: [{ ...turn('s0', 0), endedAt: 2 } as TranscriptTurn], originTurnIds: ['r3'], nextCursor: 0 };
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0']);
    expect(internals._storedHistoryTurns[0]).toMatchObject({ id: 's0', endedAt: 2 });
  });

  it('回合数变少(回退 / 分叉):手里多出来的那几轮不再画', async () => {
    const { store, internals, runtime } = opened(5, 5);
    runtime.append(turn('r5', 5));
    runtime.append(turn('r6', 6));
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0', 'r5', 'r6']);
    runtime.committed.splice(6, 1);
    await internals._refreshHistory();
    expect(committedIds(store)).toEqual(['s0', 'r5']);
  });

  it('keeps the newer history when concurrent delta replies arrive out of order', async () => {
    const { store, internals, runtime } = opened(1, 1);
    runtime.append(turn('r1', 1));
    const olderReply = await runtime.session.getHistory(undefined, 100, internals._runtimeCursor!);
    let release!: (value: typeof olderReply) => void;
    const getHistory = runtime.session.getHistory;
    let calls = 0;
    runtime.session.getHistory = (...args) => ++calls === 1
      ? new Promise((resolve) => { release = resolve; }) : getHistory(...args);
    const first = internals._refreshHistory();
    runtime.append(turn('r2', 2));
    await internals._refreshHistory();
    release(olderReply);
    await first;
    expect(committedIds(store)).toEqual(['s0', 'r1', 'r2']);
    expect(internals._runtimeCursor).toEqual({ epoch: 'runtime', seq: 3 });
    store.dispose();
  });
});

describe('reopening a host pipe resumes the retained transcript', () => {
  function retained() {
    const { store, internals } = makeStore();
    const runtime = fakeRuntime(5);
    internals._runtimeCursor = { epoch: 'runtime', seq: 5 };
    internals._runtimeCount = 5;
    internals._runtimeWindowStartSeq = 3;
    internals._runtimeTurns = runtime.committed.slice(3);
    internals._olderHistoryTurns = runtime.committed.slice(0, 3);
    internals._olderCursor = 0;
    resumeSession = runtime.session;
    return { store, internals, runtime };
  }

  it('requests only the gap and preserves previously loaded older pages', async () => {
    const { store, internals, runtime } = retained();
    runtime.append(turn('r5', 5));
    const bridge = (window as unknown as { electronAPI: { invoke: (c: string) => Promise<unknown> } }).electronAPI;
    const invoke = vi.spyOn(bridge, 'invoke');
    await internals._runBootstrap({ attachOnly: true });
    expect(runtime.calls).toEqual([{ before: undefined, changedSince: { epoch: 'runtime', seq: 5 } }]);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'sessions.getStoredHistory')).toEqual([]);
    expect(committedIds(store)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    store.dispose();
  });

  it('a host epoch change clears the stale cursor and reloads one first page', async () => {
    const { store, internals, runtime } = retained();
    runtime.restart();
    storedPage = { turns: [], originTurnIds: [], nextCursor: null };
    await internals._runBootstrap({ attachOnly: true });
    expect(runtime.calls).toEqual([
      { before: undefined, changedSince: { epoch: 'runtime', seq: 5 } },
      { before: undefined, changedSince: undefined },
    ]);
    expect(committedIds(store)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._runtimeCursor?.epoch).toBe('restarted-runtime');
    store.dispose();
  });
});

describe('#5381 评审 #3:开场补读的那几行只出一次', () => {
  it('开场那一刻才落库的一轮由库里那份出,引擎那侧不再重复;补读只读开场那页之后的行', async () => {
    const { store, internals } = makeStore();
    const runtime = fakeRuntime(5);
    internals.session = runtime.session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedOrigins = ['old'];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = 5;
    internals._runtimeCursor = { epoch: 'runtime', seq: 5 };
    internals._runtimeCount = 5;
    storedPage = { turns: [turn('s1', 1)], originTurnIds: ['r5'], nextCursor: null };
    await internals._reloadStoredTail(internals._historyGeneration);
    runtime.append(turn('r5', 5));

    await internals._refreshHistory();

    expect(committedIds(store)).toEqual(['s0', 's1']);
  });

  /** 阴控:落库失败(库里没有这一行)时,引擎那侧的这一轮照样要在屏幕上。 */
  it('阴控 —— 还没落库的一轮从引擎那侧出,不许丢', async () => {
    const { store, internals } = makeStore();
    const runtime = fakeRuntime(5);
    internals.session = runtime.session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = 5;
    internals._runtimeCursor = { epoch: 'runtime', seq: 5 };
    internals._runtimeCount = 5;
    runtime.append(turn('r5', 5));

    await internals._refreshHistory();

    expect(committedIds(store)).toEqual(['s0', 'r5']);
  });
});

describe('#5381 评审 #4:重挂会话时清掉上一次的历史状态', () => {
  it('清回初值,且代数 +1', () => {
    const { internals } = makeStore();
    internals._olderHistoryTurns = [turn('o0', 0)];
    internals._olderCursor = 3;
    internals._olderSource = 'stored';
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedBaseSeq = 0;
    internals._runtimeReplayEndSeq = 9;
    const before = internals._historyGeneration;

    internals._resetHistoryState();

    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._olderCursor).toBeUndefined();
    expect(internals._olderSource).toBe('runtime');
    expect(internals._storedHistoryTurns).toEqual([]);
    expect(internals._storedBaseSeq).toBeNull();
    expect(internals._runtimeReplayEndSeq).toBe(0);
    expect(internals._historyGeneration).toBe(before + 1);
  });

  it('重挂之前发出去的翻页,回来时对不上号就丢弃,❌ 不写回旧页', async () => {
    const { internals } = makeStore();
    let resolvePage!: (value: unknown) => void;
    internals.session = {
      getHistory: () => new Promise((resolve) => { resolvePage = resolve; }),
    };
    internals._olderSource = 'runtime';
    internals._olderCursor = 10;

    const pending = internals.loadOlderHistory();
    internals._resetHistoryState();
    resolvePage({ success: true, data: { turns: [turn('r8', 8), turn('r9', 9)], nextCursor: null } });
    await pending;

    expect(internals._olderHistoryTurns).toEqual([]);
    expect(internals._olderCursor).toBeUndefined();
  });
});
