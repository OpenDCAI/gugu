// @vitest-environment jsdom
/**
 * #5381 评审 #2 / #3 / #4 —— 界面这一层的**接线**。
 *
 * 这里钉的是 store 有没有把纯合成规则接对:
 * 取引擎那份时取没取全分界之后的一段(不是只取最新 100 轮的窗口)、每轮对账有没有从开场那页的
 * 第一行重读库、重挂之后状态有没有清、在途请求回来时对不上号有没有丢弃。
 *
 * 桥与动态 import 的写法照 `acp-chat-store.session-absent.test.ts`(那里写了为什么必须这样)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));

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

/** 与运行时 `getHistory` 同一套语义:取 seq < before 的最后 limit 条,由旧到新;取满才给游标。 */
function fakeRuntime(count: number) {
  const committed = Array.from({ length: count }, (_, seq) => turn(`r${seq}`, seq));
  const calls: Array<number | undefined> = [];
  return {
    calls,
    session: {
      getHistory: (before: number | undefined, limit = 50) => {
        calls.push(before);
        const filtered = before === undefined ? committed : committed.filter((t) => t.seq < before);
        const page = filtered.slice(-limit);
        const nextCursor = page.length === limit ? page[0]!.seq : null;
        return Promise.resolve({ success: true as const, data: { turns: page, nextCursor } });
      },
    },
  };
}

type Internals = {
  session: unknown;
  _storedHistoryTurns: TranscriptTurn[];
  _storedBaseSeq: number | null;
  _storedBootstrapMaxSeq: number;
  _runtimeReplayEndSeq: number;
  _olderHistoryTurns: TranscriptTurn[];
  _olderCursor: number | null | undefined;
  _olderSource: 'stored' | 'runtime';
  _historyGeneration: number;
  _runtimeTurnsFrom: (session: unknown, fromSeq: number) => Promise<{ success: true; data: { turns: TranscriptTurn[] } }>;
  _refreshHistory: () => Promise<void>;
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
      getHistory: vi.fn(async () => ({ success: true as const, data: { turns: turns.slice(0, 1), nextCursor: null } })),
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
    let finish!: (page: { success: true; data: { turns: TranscriptTurn[]; nextCursor: null } }) => void;
    session.getHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const stale = internals._refreshHistory();
    await store.revertMessage('m1');
    finish({ success: true, data: { turns, nextCursor: null } });
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

describe('#5381 评审 #2:引擎那份要取全分界之后的一段', () => {
  it('分界在更早的页里时,一页页往回取到够着为止', async () => {
    const { internals } = makeStore();
    const runtime = fakeRuntime(250);
    const result = await internals._runtimeTurnsFrom(runtime.session, 80);
    expect(result.data.turns.map((t) => t.seq)).toEqual(Array.from({ length: 170 }, (_, i) => 80 + i));
    expect(runtime.calls).toEqual([undefined, 150]);
  });

  it('分界就在最新一页里时,只取一次', async () => {
    const { internals } = makeStore();
    const runtime = fakeRuntime(120);
    const result = await internals._runtimeTurnsFrom(runtime.session, 100);
    expect(result.data.turns.map((t) => t.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 100 + i));
    expect(runtime.calls).toEqual([undefined]);
  });

  /** 修复前:前缀记 100,对账拿到的窗口仍是 100 条,切掉 100 条是空的,刚讲完的一轮从屏幕上消失。 */
  it('重放满 100 轮后再聊一轮,对账之后新的一轮在屏幕上', async () => {
    const { store, internals } = makeStore();
    internals.session = fakeRuntime(101).session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = 100;
    storedPage = { turns: [turn('s0', 0)], originTurnIds: ['old'], nextCursor: null };

    await internals._refreshHistory();

    expect(committedIds(store)).toEqual(['s0', 'r100']);
  });
});

describe('#5381 评审 #3:对账时重读库,已落库的那一轮只出一次', () => {
  it('开场之后才落库的一轮由库里那份出,引擎那侧不再重复', async () => {
    const { store, internals } = makeStore();
    internals.session = fakeRuntime(6).session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = 5;
    // 开场之后又落了一行,它来自引擎的 r5
    storedPage = { turns: [turn('s0', 0), turn('s1', 1)], originTurnIds: ['old', 'r5'], nextCursor: null };

    await internals._refreshHistory();

    expect(committedIds(store)).toEqual(['s0', 's1']);
  });

  /** 阴控:落库失败(库里没有这一行)时,引擎那侧的这一轮照样要在屏幕上。 */
  it('阴控 —— 还没落库的一轮从引擎那侧出,不许丢', async () => {
    const { store, internals } = makeStore();
    internals.session = fakeRuntime(6).session;
    internals._storedHistoryTurns = [turn('s0', 0)];
    internals._storedBaseSeq = 0;
    internals._storedBootstrapMaxSeq = 0;
    internals._runtimeReplayEndSeq = 5;
    storedPage = { turns: [turn('s0', 0)], originTurnIds: ['old'], nextCursor: null };

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
