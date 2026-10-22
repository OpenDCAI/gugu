import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

/**
 * 附带(owner 10-09「直接用"进入运行中"这个事件不就得了」):一行待附带、目标进入运行中那一刻按普通发送投出。
 * 可见域:session-deferred-messages 这一层 —— 真 SQLite 的 messages 行,假的状态写入者(只发 'agent:status')与假的路由。
 * 判的是:存、同键替换、只在「非 working → working」的边沿冲一次、投不进去退回、开机收残与开机冲。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

import {
  claimInterruptedDeferredMessages,
  flushDeferredMessages,
  installDeferredMessageDelivery,
  deferredMessagesSettled,
  storeDeferredMessage,
  withDeferredMessagesBeforeAdmission,
} from './session-deferred-messages';
import { setSessionMessageRouter } from './session-message-router';

type Status = { sessionId: string; reading: { status: string } | null };

function fakeWriter() {
  const listeners = new Set<(change: Status) => void>();
  return {
    on: (_event: 'agent:status', cb: (change: Status) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (sessionId: string, status: string) => listeners.forEach((cb) => cb({ sessionId, reading: { status } })),
  };
}


describe('deferred messages: kept on the session, sent when it starts working', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const routed: Array<{ sessionId: string; id: string; text: string }> = [];
  let answer: 'accepted' | 'not-ready' | 'throw' = 'accepted';

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status)
        VALUES ('s1', 'project-1', 'S1', 'claude', 'acp', 'idle');
    `);
    routed.length = 0;
    answer = 'accepted';
    setSessionMessageRouter(async (sessionId, message) => {
      routed.push({ sessionId, id: message.id, text: message.text });
      if (answer === 'throw') throw Object.assign(new Error('adapter refused before admission'), { deliveryRejectedBeforeAdmission: true });
      if (answer === 'not-ready') return { status: 'not-ready', reason: 'target session not live' };
      return { status: 'accepted', messageId: message.id, nativeReceiptId: `turn-${message.id}` };
    });
  });

  afterEach(() => {
    setSessionMessageRouter(null);
    fixture.close();
    mocks.db = undefined;
  });

  const states = () => fixture.sqlite
    .prepare("SELECT id, json_extract(metadata, '$.state') AS state FROM messages ORDER BY rowid")
    .all() as Array<{ id: string; state: string }>;

  it('attaches both committed App messages before the next model request and acknowledges only its admission', async () => {
    const writer = fakeWriter(); const stop = installDeferredMessageDelivery(writer);
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: '<app>A→B</app>' });
    storeDeferredMessage({ sessionId: 's1', id: 'B', text: '<app>B→A</app>' });
    const admitted = await withDeferredMessagesBeforeAdmission('s1', '<user>What changed?</user>', async text => {
      expect(text).toBe('<app>A→B</app>\n\n<app>B→A</app>\n\n<user>What changed?</user>');
      expect(states()).toEqual([{ id: 'A', state: 'dispatching' }, { id: 'B', state: 'dispatching' }]);
      writer.emit('s1', 'working');
      await deferredMessagesSettled('s1');
      expect(routed).toEqual([]);
      return { requestId: 'native-user-turn', declined: false };
    });
    expect(admitted.requestId).toBe('native-user-turn');
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }, { id: 'B', state: 'accepted' }]);
    expect(fixture.sqlite.prepare("SELECT DISTINCT json_extract(metadata, '$.nativeReceiptId') AS receipt FROM messages").all())
      .toEqual([{ receipt: 'native-user-turn' }]);
    stop();
  });

  it('keeps a declined or explicitly unadmitted request for the next attempt', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    await withDeferredMessagesBeforeAdmission('s1', 'USER', async () => ({ declined: true, requestId: 'declined' }));
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
    await expect(withDeferredMessagesBeforeAdmission('s1', 'USER', async () => {
      throw Object.assign(new Error('No bytes admitted'), { deliveryRejectedBeforeAdmission: true });
    })).rejects.toThrow('No bytes admitted');
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
    await withDeferredMessagesBeforeAdmission('s1', 'RETRY', async text => {
      expect(text).toBe('APP-A\n\nRETRY'); return { declined: false, requestId: 'retry' };
    });
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }]);
  });

  it('does not replay App context after an admission with unknown outcome', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    await expect(withDeferredMessagesBeforeAdmission('s1', 'USER', async () => { throw new Error('Lost RPC reply'); })).rejects.toThrow('Lost RPC reply');
    expect(states()).toEqual([{ id: 'A', state: 'outcome-unknown' }]);
    await withDeferredMessagesBeforeAdmission('s1', 'NEXT', async text => {
      expect(text).toBe('NEXT'); return { declined: false, requestId: 'next' };
    });
  });

  it('does not acknowledge context without a native admission receipt', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    await expect(withDeferredMessagesBeforeAdmission('s1', 'USER', async () => ({ declined: false, requestId: '' })))
      .rejects.toThrow('no receipt');
    expect(states()).toEqual([{ id: 'A', state: 'outcome-unknown' }]);
  });

  it('does not attach durable App facts to a replaceable queued prompt', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    await withDeferredMessagesBeforeAdmission('s1', 'REPLACEABLE', async text => {
      expect(text).toBe('REPLACEABLE'); return { declined: false, requestId: 'replaceable' };
    }, true);
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
  });

  it('does not automatically replay an uncertain working-edge dispatch either', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    const send = vi.fn(async () => { throw new Error('Lost reply after dispatch'); });
    setSessionMessageRouter(send);
    await flushDeferredMessages('s1');
    expect(states()).toEqual([{ id: 'A', state: 'outcome-unknown' }]);
    await flushDeferredMessages('s1');
    expect(send).toHaveBeenCalledOnce();
  });

  it('serializes competing requests and consumes newly committed messages only once', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    const gate = Promise.withResolvers<{ requestId: string; declined: boolean }>();
    const firstSend = vi.fn(() => gate.promise);
    const first = withDeferredMessagesBeforeAdmission('s1', 'FIRST', firstSend);
    await vi.waitFor(() => expect(firstSend).toHaveBeenCalledWith('APP-A\n\nFIRST'));
    storeDeferredMessage({ sessionId: 's1', id: 'B', text: 'APP-B' });
    const secondSend = vi.fn(async () => ({ requestId: 'second', declined: false }));
    const second = withDeferredMessagesBeforeAdmission('s1', 'SECOND', secondSend);
    await Promise.resolve(); expect(secondSend).not.toHaveBeenCalled();
    gate.resolve({ requestId: 'first', declined: false });
    await first; await second;
    expect(secondSend).toHaveBeenCalledOnce();
    expect(secondSend).toHaveBeenCalledWith('APP-B\n\nSECOND');
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }, { id: 'B', state: 'accepted' }]);
  });

  it('fences an older working-edge flush without recursively waiting on itself', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'APP-A' });
    const gate = Promise.withResolvers<{ requestId: string; declined: boolean }>();
    const routedSend = vi.fn(() => gate.promise);
    setSessionMessageRouter(async (sessionId, message) => {
      expect(message.deferredDispatch).toBe(true);
      const receipt = await withDeferredMessagesBeforeAdmission(sessionId, message.text, routedSend, message.deferredDispatch);
      return { status: 'accepted', messageId: message.id, nativeReceiptId: receipt.requestId };
    });
    const flushing = flushDeferredMessages('s1');
    await vi.waitFor(() => expect(routedSend).toHaveBeenCalledOnce());
    const send = vi.fn(async () => ({ requestId: 'user', declined: false }));
    const user = withDeferredMessagesBeforeAdmission('s1', 'USER', send);
    await Promise.resolve(); expect(send).not.toHaveBeenCalled();
    gate.resolve({ requestId: 'old-flush', declined: false });
    await flushing; await user;
    expect(send).toHaveBeenCalledWith('USER');
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }]);
  });

  it('keeps a deferred message without sending it, and replaces a waiting one of the same key', () => {
    storeDeferredMessage({ sessionId: 's1', id: 'a1', text: 'KEY1', key: 'session:caller:paper' });
    storeDeferredMessage({ sessionId: 's1', id: 'other', text: 'OTHER' });
    storeDeferredMessage({ sessionId: 's1', id: 'a2', text: 'KEY2', key: 'session:caller:paper' });
    expect(routed).toEqual([]);
    expect(states()).toEqual([{ id: 'other', state: 'deferred' }, { id: 'a2', state: 'deferred' }]);
  });

  // 变异对照:把边沿判据改成「每次读到 working 都冲」,C 会在第二次 working(没有边沿)时就被投出 ⇒ 第三条断言红。
  it('sends them the ordinary way on the edge into working, once, oldest first', async () => {
    const writer = fakeWriter();
    const stop = installDeferredMessageDelivery(writer);
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'ATT-A' });
    storeDeferredMessage({ sessionId: 's1', id: 'B', text: 'ATT-B' });
    writer.emit('s1', 'idle');
    await deferredMessagesSettled('s1');
    expect(routed).toEqual([]);
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(routed.map((entry) => entry.id)).toEqual(['A', 'B']);
    storeDeferredMessage({ sessionId: 's1', id: 'C', text: 'ATT-C' });
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(routed.map((entry) => entry.id)).toEqual(['A', 'B']);
    writer.emit('s1', 'idle');
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(routed.map((entry) => entry.id)).toEqual(['A', 'B', 'C']);
    expect(states().map((row) => row.state)).toEqual(['accepted', 'accepted', 'accepted']);
    stop();
  });

  it('a delivery that does not go in goes back to waiting, and is sent at the next edge', async () => {
    const writer = fakeWriter();
    const stop = installDeferredMessageDelivery(writer);
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'ATT-A' });
    answer = 'not-ready';
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
    answer = 'throw';
    writer.emit('s1', 'idle');
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
    answer = 'accepted';
    writer.emit('s1', 'needs_user');
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }]);
    expect(routed.map((entry) => entry.id)).toEqual(['A', 'A', 'A']);
    stop();
  });

  // A5 实撞(mac1 10-09):人这一句把冷会话拉起来,进入运行中那一刻它还在重放,投递被拒;这一轮真正开起来时写入者再发布一次。
  // 变异对照:去掉 retry 那一支,第二条断言红(还停在 deferred)。
  it('one not taken on the edge is sent at the next status publication while still working, not by a timer', async () => {
    const writer = fakeWriter();
    const stop = installDeferredMessageDelivery(writer);
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'ATT-A' });
    answer = 'throw';
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(states()).toEqual([{ id: 'A', state: 'deferred' }]);
    answer = 'accepted';
    writer.emit('s1', 'working');
    await deferredMessagesSettled('s1');
    expect(states()).toEqual([{ id: 'A', state: 'accepted' }]);
    expect(routed.map((entry) => entry.id)).toEqual(['A', 'A']);
    stop();
  });

  it('at boot: one cut short by the last process is claimed as outcome-unknown; a session already working is flushed at once', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'cut', text: 'CUT' });
    fixture.sqlite.prepare("UPDATE messages SET metadata = json_set(metadata, '$.state', 'dispatching') WHERE id = 'cut'").run();
    expect(claimInterruptedDeferredMessages()).toBe(1);
    storeDeferredMessage({ sessionId: 's1', id: 'waiting', text: 'WAIT' });
    fixture.sqlite.prepare("UPDATE sessions SET agent_status = 'working' WHERE id = 's1'").run();
    const stop = installDeferredMessageDelivery(fakeWriter());
    await deferredMessagesSettled('s1');
    expect(routed.map((entry) => entry.id)).toEqual(['waiting']);
    expect(states()).toEqual([{ id: 'cut', state: 'outcome-unknown' }, { id: 'waiting', state: 'accepted' }]);
    stop();
  });

  it('two flushes of one session at once claim each row once', async () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'ATT-A' });
    await Promise.all([flushDeferredMessages('s1'), flushDeferredMessages('s1')]);
    expect(routed.map((entry) => entry.id)).toEqual(['A']);
  });

  it('goes with its session when the session is deleted', () => {
    storeDeferredMessage({ sessionId: 's1', id: 'A', text: 'ATT-A' });
    fixture.sqlite.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(states()).toEqual([]);
  });
});
