import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceRpcHandlerContext } from '@gugu/core/cloud/deviceRpcResponder';
import { MESSAGE_PREVIEW_RPC, type MessagePreviewPayload } from '@gugu/session-core/session-record/message-preview';

const state = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  snapshot: vi.fn(),
  emit: null as null | (() => void),
}));

vi.mock('./service', () => ({
  nativeRecord: vi.fn(), nativeToolImage: vi.fn(), nativeAttachment: vi.fn(),
  subscribe: (...args: unknown[]) => state.subscribe(...args),
  unsubscribe: (...args: unknown[]) => state.unsubscribe(...args),
  snapshot: (...args: unknown[]) => state.snapshot(...args),
}));

const { createMessagePreviewHost, MESSAGE_PREVIEW_MAX_WATCHES } = await import('./preview-rpc');

const CHAT = 'a79a955c-c977-464f-afb4-a118360ef51a';
const AGENT = '7d724d74-6339-4275-b92a-b36506659b05';

function envelope(chat: string): string {
  return `<gugu_delivery route="chat" chat="${chat}" msg="msg:1">\n<![CDATA[做个设计]]>\n</gugu_delivery>`;
}

function turns(chat: string, said: string) {
  return [
    {
      id: 'turn-1',
      seq: 1,
      initiator: 'user',
      items: [
        { kind: 'message', id: 'u1', seq: 1, role: 'user', text: envelope(chat) },
        { kind: 'thinking', id: 't1', seq: 2, segmentId: 's', text: '私密思考', status: 'done', startedAt: 1 },
        { kind: 'message', id: 'a1', seq: 3, role: 'assistant', text: said },
      ],
      outcome: { kind: 'done', reason: 'end_turn' },
    },
  ];
}

const ctx = {} as DeviceRpcHandlerContext;
const request = (subscriptionId: string, extra: Record<string, unknown> = {}) => ({
  chatId: CHAT,
  chatPublicId: 207974,
  agentId: AGENT,
  subscriptionId,
  ...extra,
});

function setup(options: { sessionId?: string | null } = {}) {
  const sent: MessagePreviewPayload[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let clock = 1_000_000;
  const host = createMessagePreviewHost({
    resolveSessionId: () => (options.sessionId === undefined ? 'conv-1' : options.sessionId),
    openPublisher: (topic) => {
      opened.push(topic);
      return { send: (payload) => sent.push(payload), close: () => closed.push(topic) };
    },
    now: () => clock,
    idleMs: 90_000,
    throttleMs: 1_000,
  });
  return { host, sent, opened, closed, advance: (ms: number) => (clock += ms) };
}

const flush = async () => {
  await vi.runAllTimersAsync();
};

describe('MessagePreview 宿主', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.subscribe = vi.fn(async (_input: unknown, emit: () => void) => {
      state.emit = emit;
      return { ok: true, value: { subscriptionId: 'x' } };
    });
    state.unsubscribe = vi.fn();
    state.snapshot = vi.fn(async () => ({ ok: true, value: { turns: turns('207974', '本群的进展') } }));
  });
  afterEach(() => vi.useRealTimers());

  it('订阅:复用时间线服务的订阅,推到本群的预览 topic,内容是投影不是原文', async () => {
    const { host, sent, opened } = setup();
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await flush();
    expect(reply).toEqual({ result: { topic: `gugu:preview:${CHAT}:${AGENT}` } });
    expect(state.subscribe).toHaveBeenCalledWith(
      { conversationId: 'conv-1', subscriptionId: expect.stringMatching(new RegExp(`^preview:gugu:preview:${CHAT}:${AGENT}:`)), cursor: null },
      expect.any(Function),
    );
    expect(opened).toEqual([`gugu:preview:${CHAT}:${AGENT}`]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: CHAT, agentId: AGENT, rev: 1, entries: [{ kind: 'prompt', messageId: 'msg:1' }, { kind: 'text', text: '本群的进展' }] });
    expect(JSON.stringify(sent)).not.toContain('私密思考');
  });

  it('别的群的活:不按 chat 过滤,同样推给这个群(#6573)', async () => {
    state.snapshot = vi.fn(async () => ({ ok: true, value: { turns: turns('999', 'A 群的进展') } }));
    const { host, sent } = setup();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await flush();
    expect(sent[0]?.entries).toMatchObject([{ kind: 'prompt', messageId: 'msg:1' }, { kind: 'text', text: 'A 群的进展' }]);
    expect(JSON.stringify(sent)).not.toContain('私密思考');
  });

  it('变化才推、节流合并;内容没变不重推', async () => {
    const { host, sent } = setup();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await flush();
    state.emit!();
    state.emit!();
    await flush();
    expect(sent).toHaveLength(1); // 快照没变 ⇒ 不推
    state.snapshot = vi.fn(async () => ({ ok: true, value: { turns: turns('207974', '又写了一句') } }));
    state.emit!();
    state.emit!();
    state.emit!();
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ rev: 2, entries: [{ kind: 'prompt' }, { kind: 'text', text: '又写了一句' }] });
  });

  it('同群第二个人:共用一份订阅,但补推一份给新来的人;续期不重推', async () => {
    const { host, sent, opened } = setup();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await flush();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v2'), ctx);
    await flush();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    expect(sent).toHaveLength(2);
    await host.handlers[MESSAGE_PREVIEW_RPC.keepalive]!(request('v2'), ctx);
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('最后一张租约退订 ⇒ 整份拆掉(没人看就一个字节都不发)', async () => {
    const { host, closed } = setup();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v2'), ctx);
    await flush();
    await host.handlers[MESSAGE_PREVIEW_RPC.unsubscribe]!(request('v1'), ctx);
    expect(state.unsubscribe).not.toHaveBeenCalled();
    await host.handlers[MESSAGE_PREVIEW_RPC.unsubscribe]!(request('v2'), ctx);
    expect(state.unsubscribe).toHaveBeenCalledWith(state.subscribe.mock.calls[0]![0].subscriptionId);
    expect(closed).toEqual([`gugu:preview:${CHAT}:${AGENT}`]);
    expect(host.watchCount()).toBe(0);
  });

  it('90s 没保活的租约被清扫;保活过的留下', async () => {
    const { host, advance } = setup();
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v2'), ctx);
    await flush();
    advance(60_000);
    await host.handlers[MESSAGE_PREVIEW_RPC.keepalive]!(request('v2'), ctx);
    advance(40_000);
    expect(host.sweep()).toEqual(['v1']);
    expect(host.watchCount()).toBe(1);
    advance(90_001);
    expect(host.sweep()).toEqual(['v2']);
    expect(host.watchCount()).toBe(0);
  });

  it('agent 不在本机:响亮报错,不开任何东西', async () => {
    const { host, opened } = setup({ sessionId: null });
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    expect(reply).toMatchObject({ error: { code: 'agent_not_hosted' } });
    expect(opened).toEqual([]);
    expect(state.subscribe).not.toHaveBeenCalled();
  });

  it('记录读不到(record_not_found):原错误码经预览 topic 推给查看端,这份留到退订才拆', async () => {
    const notFound = { code: 'record_not_found', message: '找不到 claude 会话记录：sessionId=s-1' };
    state.subscribe = vi.fn(async () => ({ ok: false, error: notFound }));
    state.snapshot = vi.fn(async () => ({ ok: false, error: notFound }));
    const { host, sent, opened, closed } = setup();
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await flush();
    expect(reply).toEqual({ error: notFound });
    expect(opened).toEqual([`gugu:preview:${CHAT}:${AGENT}`]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: CHAT, agentId: AGENT, rev: 1, running: false, entries: [], error: notFound });
    expect(host.watchCount()).toBe(1);
    await host.handlers[MESSAGE_PREVIEW_RPC.unsubscribe]!(request('v1'), ctx);
    expect(closed).toEqual([`gugu:preview:${CHAT}:${AGENT}`]);
    expect(host.watchCount()).toBe(0);
  });

  it('载荷不全:invalid_payload', async () => {
    const { host } = setup();
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!({ chatId: CHAT }, ctx);
    expect(reply).toMatchObject({ error: { code: 'invalid_payload' } });
  });

  it('同时开着的预览有上限(请求来自别人,资源必须有顶)', async () => {
    const { host } = setup();
    for (let i = 0; i < MESSAGE_PREVIEW_MAX_WATCHES; i += 1) {
      await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request(`v${i}`, { chatId: `chat-${i}` }), ctx);
    }
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('over', { chatId: 'chat-over' }), ctx);
    expect(reply).toMatchObject({ error: { code: 'too_many_previews' } });
    host.dispose();
    expect(host.watchCount()).toBe(0);
  });

  it('订阅还在飞时就被退订:订阅落地后当场撤掉,❌ 不留孤儿订阅', async () => {
    let release: (value: unknown) => void = () => {};
    state.subscribe = vi.fn(
      () => new Promise((resolve) => {
        release = () => resolve({ ok: true, value: { subscriptionId: 'x' } });
      }),
    );
    const { host } = setup();
    const pending = host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    await Promise.resolve();
    await Promise.resolve();
    await host.handlers[MESSAGE_PREVIEW_RPC.unsubscribe]!(request('v1'), ctx);
    release(undefined);
    const reply = await pending;
    expect(reply).toMatchObject({ error: { code: 'preview_closed' } });
    const id = state.subscribe.mock.calls[0]![0].subscriptionId;
    expect(state.unsubscribe).toHaveBeenLastCalledWith(id);
    expect(host.watchCount()).toBe(0);
  });

  it('host 已拆(频道重建):新来的订阅直接拒,不开任何东西', async () => {
    const { host, opened } = setup();
    host.dispose();
    const reply = await host.handlers[MESSAGE_PREVIEW_RPC.subscribe]!(request('v1'), ctx);
    expect(reply).toMatchObject({ error: { code: 'host_disposed' } });
    expect(opened).toEqual([]);
  });
});
