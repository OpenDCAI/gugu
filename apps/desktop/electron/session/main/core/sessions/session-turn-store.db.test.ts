import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';

// spec session-history-replay:历史是会话页自己持久化的,重放不再是唯一来源。
//
// 这里守的是那条只有主进程做得了的判断 —— 一回合该不该落盘:
//  ① live 一律落。
//  ② replay 只在库里一行都没有时落(老会话 / 刚从编程模式切过来的会话做一次回填);
//     库里已有历史时必须丢弃 —— 库里那份是完整的,重放只含压缩边界之后的一段。
//  ③ seq 由这里按到达序分配,❌ 不复用运行时那份回合序号(重开会话后它从 0 重数,会撞号)。

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { nativeConversationUnread } from './session-conversation-read';
import { startNativeConversationInboxHost } from './native-conversation-inbox';
import { events } from '@main/lib/events';
import { appendRecordTurnNow, getStoredToolImage, persistCommittedTurn, readStoredTailNow, readStoredTurns, storedRevertBoundary, storedTurnIndexBase, truncateStoredHistory, withStoredTurns } from './session-turn-store';

type Fixture = Awaited<ReturnType<typeof openFixture>>;

/**
 * `seq` 是这一回合**在本次会话里**的序号（重开会话后从 0 重数）。
 * ⚠️ 它是回填判据的一半，❌ 别再像从前那样一律写死 0 —— 写死之后「同一次重放的第 2、3 条」
 * 这类用例根本造不出来，而那正是漏掉的那个 bug。
 */
function turn(id: string, text: string, seq = 0): TranscriptTurn {
  return {
    id,
    seq,
    initiator: 'user',
    items: [{ kind: 'message', id: `${id}:m`, seq: 0, role: 'user', text }],
  } as TranscriptTurn;
}

const storedTexts = (fixture: Fixture) =>
  (
    fixture.sqlite
      .prepare('SELECT seq, data FROM session_turns ORDER BY seq')
      .all() as { seq: number; data: string }[]
  ).map((row) => (JSON.parse(row.data) as TranscriptTurn).items[0]);

describe('conversation-turn-store', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');
    `);
  });

  afterEach(() => { fixture.close(); vi.clearAllMocks(); });

  it('requests the inbox address when a new task records its first real owner exchange', async () => {
    const open = vi.fn(async () => 'canonical-dm');
    const inbox = startNativeConversationInboxHost({ open, failed: error => { throw error; } });
    try {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: {
        ...turn('first-owner-turn', 'First personal input'), trigger: { kind: 'owner' }, startedAt: 1000, endedAt: 2000,
        items: [
          { kind: 'message', id: 'owner-input', seq: 0, role: 'user', text: 'First personal input', at: 1000 },
          { kind: 'message', id: 'owner-reply', seq: 1, role: 'assistant', text: 'First personal reply', at: 2000 },
        ],
      } });
      await inbox.flush();
      expect(open).toHaveBeenCalledExactlyOnceWith({ sessionId: 'c1', projectId: 'p1' });
      const entry = fixture.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get('native-conversation-inbox:c1') as { value: string } | undefined;
      expect(entry && JSON.parse(entry.value)).toEqual({ projectId: 'p1', chatId: 'canonical-dm' });
    } finally { inbox.dispose(); }
  });

  it.each(['agent', 'schedule', 'delivery'] as const)('does not request a personal DM for live %s work', async kind => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: {
      ...turn('background', 'Background activity'), trigger: { kind }, startedAt: 1000, endedAt: 2000,
      items: [{ kind: 'message', id: 'background', seq: 0, role: 'assistant', text: 'Background reply', at: 2000 }],
    } });
    expect(fixture.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get('native-conversation-inbox:c1')).toBeUndefined();
  });

  it('does not request a DM when startup replay or a historical revision brings back old personal messages', async () => {
    const old = { ...turn('old-personal', 'Historical personal input'), trigger: { kind: 'owner' as const }, startedAt: 1000, endedAt: 2000 };
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: old });
    await persistCommittedTurn({ sessionId: 'c1', source: 'revision', turn: old });
    expect(fixture.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get('native-conversation-inbox:c1')).toBeUndefined();
  });

  it('#980 continues runtime turn numbers after every stored run, ignoring store-renumbered and record rows', async () => {
    expect(await storedTurnIndexBase('c1')).toBe(0);
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', 'first run') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:6', 'later run', 6) });
    await withStoredTurns('c1', () => appendRecordTurnNow('c1', turn('c1:turn:2', 'from the record', 2)));
    expect(await storedTurnIndexBase('c1')).toBe(7);
  });

  it('#980 appends record turns after the store tail, inside the same per-session write chain', async () => {
    const live = persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', 'chat turn') });
    const filled = withStoredTurns('c1', async () => {
      const tail = await readStoredTailNow('c1', 10);
      await appendRecordTurnNow('c1', turn('c1:turn:1', 'terminal turn', 1));
      return tail.length;
    });
    // The fill waited for the live write queued before it.
    expect(await filled).toBe(1);
    await live;
    expect(storedTexts(fixture).map((item) => item.kind === 'message' ? item.text : null)).toEqual(['chat turn', 'terminal turn']);
    const page = await readStoredTurns('c1');
    expect(page.originTurnIds).toEqual(['c1:turn:0', 'record:c1:turn:1']);
    expect(page.turns[1].id).toBe('c1:turn:s1');
  });

  it('retains exact live reference identities when repeated runtime IDs are stored and reread', async () => {
    const runtimeId = 'c1:turn:0';
    for (const referenceId of ['source:first-run', 'source:restarted-run']) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: { ...turn(runtimeId, 'same words'), referenceId } });
    }
    const reopened = await readStoredTurns('c1');
    expect(reopened.originTurnIds).toEqual([runtimeId, runtimeId]);
    expect(reopened.turns.map(t => t.id)).toEqual(['c1:turn:s0', 'c1:turn:s1']);
    expect(reopened.turns.map(t => t.referenceId)).toEqual(['source:first-run', 'source:restarted-run']);
    expect(reopened.turns.map(t => t.items[0]!.id)).toEqual(['c1:turn:s0:m', 'c1:turn:s1:m']);
  });

  it('resolves a stopped runtime picture through its persisted origin without confusing reused runtime IDs', async () => {
    const originalId = 'c1:turn:0';
    const imageTurn = (data: string): TranscriptTurn => ({
      ...turn(originalId, 'picture'),
      items: [{ kind: 'mcp-tool-call', id: originalId + ':tool:pic', seq: 0,
        toolCallId: 'pic', tool: 'screenshot', title: 'Screenshot', status: 'done', images: [{ mimeType: 'image/png', data }] }],
    });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: imageTurn('earlier') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: imageTurn('latest') });
    expect(await getStoredToolImage({ sessionId: 'c1', originTurnId: originalId, itemId: originalId + ':tool:pic', index: 0 }))
      .toEqual({ ok: true, image: { mimeType: 'image/png', data: 'latest' } });
    expect(await getStoredToolImage({ sessionId: 'c1', seq: 0, itemId: 'c1:turn:s0:tool:pic', index: 0 }))
      .toEqual({ ok: true, image: { mimeType: 'image/png', data: 'earlier' } });
  });

  it('回退按原生凭据裁剪落盘历史,重开和继续发送都不复活旧后缀 (#7304)', async () => {
    for (let seq = 0; seq < 3; seq += 1) {
      const value = turn(`runtime:turn:${seq}`, `message-${seq}`, seq);
      const first = value.items[0]!;
      if (first.kind === 'message') first.revertAnchor = `native-${seq}`;
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: value });
    }
    expect(await storedRevertBoundary('c1', 'native-1')).toBe(1);
    await truncateStoredHistory('c1', 1);
    expect((await readStoredTurns('c1')).turns.map((t) => t.seq)).toEqual([0]);
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('runtime:turn:3', 'replacement', 3) });
    const reopened = await readStoredTurns('c1');
    expect(reopened.turns.map((t) => t.items[0])).toMatchObject([
      { text: 'message-0', revertAnchor: 'native-0' }, { text: 'replacement' },
    ]);
    expect(reopened.turns.map((t) => t.id)).toEqual(['c1:turn:s0', 'c1:turn:s1']);
  });

  it('找不到回退点时保留已落盘历史,不会按位置猜测 (#7304)', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('original', 'keep') });
    await expect(storedRevertBoundary('c1', 'missing')).rejects.toThrow('no longer contains');
    expect((await readStoredTurns('c1')).turns).toHaveLength(1);
  });

  it('live 的回合按到达序一条条落盘', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '第一句') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', '第二句') });

    const rows = fixture.sqlite
      .prepare('SELECT id, seq, turn_id FROM session_turns ORDER BY seq')
      .all() as { id: string; seq: number; turn_id: string }[];
    // turn_id 记**这一行来自引擎的哪一轮**(运行时原始 id),界面拿它判断新提交的一轮是否已落库。
    // 库里自己的 id 在 data 里重编成 `:turn:sN`,跨重启不撞号 —— 见下面「跨重启的 id」那一组。
    expect(rows).toEqual([
      { id: 'c1:0', seq: 0, turn_id: 'c1:turn:0' },
      { id: 'c1:1', seq: 1, turn_id: 'c1:turn:1' },
    ]);
  });

  it('已落盘回合的 revision 只更新最新投影,不新增一行', async () => {
    await persistCommittedTurn({
      sessionId: 'c1',
      source: 'live',
      turn: {
        ...turn('c1:turn:0', '失败'),
        outcome: { kind: 'error', reason: 'prompt_failed', detail: 'ACP connection closed' },
      },
    });
    await persistCommittedTurn({
      sessionId: 'c1',
      source: 'revision',
      turn: {
        ...turn('c1:turn:0', '失败'),
        outcome: { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' },
      },
    });

    const rows = fixture.sqlite
      .prepare('SELECT seq, data FROM session_turns ORDER BY seq')
      .all() as { seq: number; data: string }[];
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0]!.data) as TranscriptTurn).outcome).toEqual({
      kind: 'error',
      reason: 'process_closed',
      detail: 'signal=SIGKILL',
    });
  });

  it('revision 带来的迟到尾巴整轮落盘,id 按库里序号重编(#6191)', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '占位') });
    const stopped: TranscriptTurn = {
      ...turn('c1:turn:1', 'sleep 120'),
      outcome: { kind: 'cancelled', reason: 'cancelled' },
    } as TranscriptTurn;
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: stopped });
    await persistCommittedTurn({
      sessionId: 'c1',
      source: 'revision',
      turn: {
        ...stopped,
        items: [
          ...stopped.items,
          { kind: 'message', id: 'c1:turn:1:m2', seq: 1, role: 'assistant', text: 'Info: Operation cancelled by user' },
        ],
      } as TranscriptTurn,
    });

    const rows = fixture.sqlite
      .prepare('SELECT seq, data FROM session_turns ORDER BY seq')
      .all() as { seq: number; data: string }[];
    expect(rows).toHaveLength(2);
    const revised = JSON.parse(rows[1]!.data) as TranscriptTurn;
    expect(nativeConversationUnread('c1')).toEqual(['c1:turn:s1:m2']);
    expect(revised.outcome).toEqual({ kind: 'cancelled', reason: 'cancelled' });
    expect(revised.items.map((item) => [item.id, (item as { text: string }).text])).toEqual([
      ['c1:turn:s1:m', 'sleep 120'],
      ['c1:turn:s1:m2', 'Info: Operation cancelled by user'],
    ]);
  });

  it('backfill 改写的是更早那一行,之后的行原样不动(#6582)', async () => {
    const launch = turn('c1:turn:0', 'poll CI in the background');
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: launch });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', 'anything else?', 1) });
    await persistCommittedTurn({
      sessionId: 'c1',
      source: 'backfill',
      turn: {
        ...launch,
        items: [
          ...launch.items,
          { kind: 'execute-tool-call', id: 'c1:turn:0:tool:call_bg', seq: 1, toolCallId: 'call_bg', backgroundTaskId: 'bg-1', backgroundTaskDone: true },
        ],
      } as TranscriptTurn,
    });

    const rows = fixture.sqlite
      .prepare('SELECT seq, data FROM session_turns ORDER BY seq')
      .all() as { seq: number; data: string }[];
    expect(rows).toHaveLength(2);
    const backfilled = JSON.parse(rows[0]!.data) as TranscriptTurn;
    expect(backfilled.items.at(-1)).toMatchObject({ id: 'c1:turn:s0:tool:call_bg', backgroundTaskDone: true });
    expect((JSON.parse(rows[1]!.data) as TranscriptTurn).items.map((item) => (item as { text?: string }).text)).toEqual([
      'anything else?',
    ]);
  });

  it('前一条写入失败后,排队的后一条仍然落盘', async () => {
    fixture.sqlite.exec("CREATE TRIGGER fail_first BEFORE INSERT ON session_turns WHEN NEW.turn_id = 'c1:turn:0' BEGIN SELECT RAISE(ABORT, 'transient insert failure'); END");
    const first = persistCommittedTurn({
      sessionId: 'c1',
      source: 'live',
      turn: turn('c1:turn:0', '失败的写入'),
    });
    const second = persistCommittedTurn({
      sessionId: 'c1',
      source: 'live',
      turn: turn('c1:turn:1', '后续写入'),
    });

    await expect(first).rejects.toThrow('transient insert failure');
    await expect(second).resolves.toBeUndefined();
    expect(storedTexts(fixture).map((item) => ('text' in item ? item.text : null))).toEqual(['后续写入']);

  });

  it('rolls back the stored turn when its unread journal cannot be committed', async () => {
    fixture.sqlite.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON kv WHEN NEW.key = 'native-conversation-read:c1' BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END");
    const reply: TranscriptTurn = { ...turn('c1:turn:0', 'question'), items: [{ kind: 'message', id: 'c1:turn:0:message:reply', seq: 0, role: 'assistant', text: 'answer' }] };
    await expect(persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: reply })).rejects.toThrow('journal unavailable');
    expect(storedTexts(fixture)).toEqual([]);
    expect(nativeConversationUnread('c1')).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
    fixture.sqlite.exec('DROP TRIGGER fail_journal');
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: reply });
    expect(nativeConversationUnread('c1')).toEqual(['c1:turn:s0:message:reply']);
    await truncateStoredHistory('c1', 0);
    expect(storedTexts(fixture)).toEqual([]);
    expect(nativeConversationUnread('c1')).toEqual([]);
  });

  it('库里空时,重放回来的历史被吃进来(老会话 / 刚从编程模式切过来的会话)', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:0', '编程模式期间说的') });

    expect(storedTexts(fixture)).toHaveLength(1);
  });

  /**
   * 回归 —— 判据曾经是「库里现在一行都没有」，那只在**第一条**重放回合上成立：补完那一条，
   * 库里就有行了，同一次重放的第 2、3 条全被当成重复丢掉，库里留下一个只有开头的残缺历史。
   * 更坏的是下次重开：上屏逻辑按「库里那份是完整的」把重放回来的其余部分整段跳过 ——
   * 2026-09-10 隔离实例实撞，一条对照会话补完后重开只剩 2 个渲染块，补之前是 6 个。
   */
  it('回填要吃完整段重放,❌ 不是只吃第一条', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:0', '第一段', 0) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:1', '第二段', 1) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:2', '第三段', 2) });

    expect(storedTexts(fixture)).toHaveLength(3);
  });

  /**
   * 阴控 —— 回填完之后再重开一次:重放又把同样那几条推回来,这次必须一条都不写。
   * 判据靠序号对齐天然排除它:库里已有 3 行,而重放的第一条序号是 0,对不上。
   */
  it('阴控 —— 回填过的会话再重开,重放不许再写一遍', async () => {
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn(`c1:turn:${i}`, `第${i}段`, i) });
    }
    // 重开:同一段历史又被推回来一次
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn(`c1:turn:${i}`, `第${i}段`, i) });
    }

    expect(storedTexts(fixture)).toHaveLength(3);
  });

  /**
   * 这条是整个改动的要害。库里已经有完整历史时,重放推回来的那一段(压缩边界之后)必须丢掉 ——
   * 否则每重开一次会话,尾巴上那几轮就被再写一遍,用户看到自己说过的话重复出现。
   */
  it('库里已有历史时,重放回来的一律丢弃', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '压缩前说的') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', '压缩后说的') });

    // 重启:重放只推回压缩边界之后那一段(它在新会话里的序号从 0 重数)
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:0', '压缩后说的', 0) });

    expect(storedTexts(fixture)).toHaveLength(2);
  });

  it('does not append a replay tail when its sequence catches up to an existing archive', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('live:0', 'already archived') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('replay:0', 'earlier replay part', 0) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('replay:1', 'already archived', 1) });
    expect(storedTexts(fixture)).toHaveLength(1);
  });

  it('hides an old untimed replay twin by native identities, keeping the raw archive and later turns', async () => {
    const userId = '00000000-0000-4000-8000-0000000000a1', answerId = '00000000-0000-4000-8000-0000000000a2';
    const original: TranscriptTurn = { id: 'c1:turn:29', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 2000, outcome: { kind: 'done' }, items: [
      { kind: 'message', id: `c1:turn:29:message:${userId}`, seq: 0, role: 'user', text: 'file caption' },
      { kind: 'message', id: `c1:turn:29:message:${answerId}`, seq: 1, role: 'assistant', text: 'received' },
    ] };
    const duplicate: TranscriptTurn = { id: 'c1:turn:30', seq: 1, initiator: 'user', items: original.items.map(item => ({ ...item, id: item.id.replace('turn:29:', 'turn:30:') })) };
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: original });
    // Simulate a row already written by the old producer; its original source marker was not stored.
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: duplicate });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('new-live', 'new input') });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM session_turns').get()).toEqual({ n: 3 });
    expect((await readStoredTurns('c1')).turns.map(row => row.seq)).toEqual([0, 2]);
    expect((await readStoredTurns('c1', { fromSeq: 1 })).turns.map(row => row.seq)).toEqual([2]);
    const older = await readStoredTurns('c1', { before: 2, limit: 1 });
    expect(older.turns.map(row => row.seq)).toEqual([0]);
    expect(older.originTurnIds).toEqual([original.id]);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM session_turns').get()).toEqual({ n: 3 });
    const differentIds = { ...duplicate, id: 'c1:turn:33', items: duplicate.items.map((item, index) => ({ ...item,
      id: `c1:turn:33:message:${index ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001'}`,
    })) };
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: differentIds });
    // Identical words with new native identities, and genuinely live rows, must both remain.
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: { ...original, startedAt: 3000, endedAt: 4000 } });
    expect((await readStoredTurns('c1')).turns.map(row => row.seq)).toEqual([0, 2, 3, 4]);
  });

  it('重放吃进来之后,后续 live 接着往下长,不覆盖前面的', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:0', '切换前的', 0) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', '切换后的', 1) });

    const rows = fixture.sqlite
      .prepare('SELECT seq FROM session_turns ORDER BY seq')
      .all() as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
  });

  it('读回来是由旧到新,取满一页才给游标', async () => {
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn(`c1:turn:${i}`, `第${i}句`) });
    }

    const head = await readStoredTurns('c1', { limit: 2 });
    expect(head.turns.map((t) => t.id)).toEqual(['c1:turn:s1', 'c1:turn:s2']);
    expect(head.nextCursor).toBe(1);

    const older = await readStoredTurns('c1', { limit: 2, before: head.nextCursor ?? undefined });
    expect(older.turns.map((t) => t.id)).toEqual(['c1:turn:s0']);
    // 取回来的比要的少 = 到头了。❌ 别拿「正好取满」当还有下一页。
    expect(older.nextCursor).toBeNull();
  });
});

/**
 * #5381 —— 跨重启的会话不许出现两条 id 相同的回合。
 *
 * 运行时那份回合序号每次重开都从 0 重数,而 turn.id 与它下面所有条目的 id 都由它派生。
 * 实测过:一条会话重启后又说了一轮,库里第 5 行的 turn.id 与第 3 行**逐字相同**。
 * id 是转录的主键 —— scrollToItem、按 id 定位、折叠状态、框架 keying 全靠它。
 */
describe('conversation-turn-store · 跨重启的 id', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');
    `);
  });

  it('重启后运行时序号从 0 重数,库里的 id 仍然互不相同', async () => {
    // 第一次会话:回合 0、1
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '一', 0) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', '二', 1) });
    // 重启:运行时又从 0 开始
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '三', 0) });

    const rows = fixture.sqlite
      .prepare('SELECT turn_id, data FROM session_turns ORDER BY seq')
      .all() as { turn_id: string; data: string }[];
    // 库里的 id(data 里那份)互不相同;turn_id 记的是来源,跨重启重复是正常的。
    const ids = rows.map((r) => (JSON.parse(r.data) as TranscriptTurn).id);
    expect(new Set(ids).size).toBe(3);
    expect(rows.map((r) => r.turn_id)).toEqual(['c1:turn:0', 'c1:turn:1', 'c1:turn:0']);
    // 而且顺序单调 —— 转录那侧按 turn.seq 判有没有乱序。
    const seqs = rows.map((r) => (JSON.parse(r.data) as TranscriptTurn).seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('回合里条目的 id 跟着一起重编,❌ 不留下指向旧回合的半截前缀', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '一', 0) });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', '二', 0) });

    const rows = fixture.sqlite
      .prepare('SELECT data FROM session_turns ORDER BY seq')
      .all() as { data: string }[];
    const second = JSON.parse(rows[1]!.data) as TranscriptTurn;
    expect(second.id).toBe('c1:turn:s1');
    expect(second.items[0]!.id).toBe('c1:turn:s1:m');
  });

  /** 阴控:正文里恰好出现同样的字符串不许被误伤 —— 重编号只动 id 字段。 */
  it('阴控 —— 消息正文里的同名字符串原样保留', async () => {
    const t = turn('c1:turn:0', '我刚才提到 c1:turn:0 这个 id', 0);
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: t });

    const row = fixture.sqlite.prepare('SELECT data FROM session_turns').get() as { data: string };
    const stored = JSON.parse(row.data) as TranscriptTurn;
    expect((stored.items[0] as { text: string }).text).toBe('我刚才提到 c1:turn:0 这个 id');
  });
});

/**
 * #5381 评审 #2 / #3 —— 界面每轮对账的读法。
 *
 * 界面不再按条数切引擎那份,而是:从开场那页的第一行起重读库(库内 seq 只增不减,中间写进多少行都不断档),
 * 再按每一行「来自引擎哪一轮」认出已落库的,引擎那侧就不再重复出它们。
 */
describe('conversation-turn-store · 对账读法', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');
    `);
  });

  it('fromSeq 读回该 seq 起的全部行,带着每一行来自引擎的哪一轮', async () => {
    for (let i = 0; i < 5; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn(`c1:turn:${i}`, `第${i}句`, i) });
    }
    const page = await readStoredTurns('c1', { fromSeq: 2 });
    expect(page.turns.map((t) => t.seq)).toEqual([2, 3, 4]);
    expect(page.originTurnIds).toEqual(['c1:turn:2', 'c1:turn:3', 'c1:turn:4']);
    expect(page.nextCursor).toBeNull();
  });

  it('分页读法同样带出来源 id,与 turns 一一对应', async () => {
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn(`c1:turn:${i}`, `第${i}句`, i) });
    }
    const page = await readStoredTurns('c1', { limit: 2 });
    expect(page.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(page.originTurnIds).toEqual(['c1:turn:1', 'c1:turn:2']);
  });
});
