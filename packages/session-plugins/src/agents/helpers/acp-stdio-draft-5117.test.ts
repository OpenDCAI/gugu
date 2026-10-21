/**
 * #5117 —— 草案 update 的进门信封。
 *
 * owner 2026-09-06 实测:握手谈成之后 agent 确实发 `subagent_spawned`,但客户端在
 * `ClientSideConnection` 的运行时校验上以 `-32602 Invalid params` 整条拒收 ⇒ 子智能体的
 * 完成事件永远到不了,那一轮不收口、模型被反复叫醒,界面上是三条「收到」。
 *
 * ⇒ 这组用例钉两件事:草案那几种**被裹进信封**,以及普通 update **一个字节都不许动**。
 */
import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate, DRAFT_UPDATE_META_KEY } from '@gugu/session-core/acp';
import { rewriteDraftSessionUpdates } from './acp-stdio';

function streamOf(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split('\n').filter(Boolean);
}

/** 走一遍真正的改写:❌ 别直接 drain(streamOf(...)),那样连阳控都是假的。 */
const through = (lines: readonly string[]) => drain(rewriteDraftSessionUpdates(streamOf(lines)));

const notify = (update: unknown) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });

describe('#5117 草案 update 的进门信封', () => {
  it('subagent_spawned 被裹进 SDK 认得的信封,原件完整留在 _meta 里', async () => {
    const [line] = await through([
      notify({
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'a533d69b17d46cccd',
        name: '回传口令',
        task: '把口令原样回传',
        capabilities: {},
      }),
    ]);

    const update = JSON.parse(line).params.update;
    expect(update.sessionUpdate).toBe('tool_call_update');
    expect(update.toolCallId).toBe('a533d69b17d46cccd');
    const inner = update._meta[DRAFT_UPDATE_META_KEY];
    expect(inner.sessionUpdate).toBe('subagent_spawned');
    expect(inner.name).toBe('回传口令');
  });

  it('后台任务那几种按 asyncTaskId 认领', async () => {
    const [line] = await through([
      notify({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't1', canStop: true }),
    ]);
    const update = JSON.parse(line).params.update;
    expect(update.toolCallId).toBe('t1');
    expect(update._meta[DRAFT_UPDATE_META_KEY].canStop).toBe(true);
  });

  it('阴控:普通 update 原样放行 —— ❌ 一个字节都不许动', async () => {
    // 少了这条,「把每一条都裹起来」这种会废掉整条协议的实现可以拿绿灯。
    const original = notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好' },
    });
    const [line] = await through([original]);
    expect(line).toBe(original);
  });

  it('阴控:白名单之外的变体即使带着 id 也不裹', async () => {
    /**
     * ⚠️ 这条是**补上来**的,因为上面那条「普通 update 原样放行」是**为错的理由变绿**:
     * 普通 update 本来就没有 `asyncTaskId`,会被后面「没有 id 就放行」那道先挡住 ⇒
     * 变体白名单被整个删掉,那条照样绿(2026-09-06 变异验证实测:6/6 全过)。
     * 这条给它一个 id,让白名单成为**唯一**能挡住它的东西。
     */
    const original = notify({ sessionUpdate: 'some_future_update', asyncTaskId: 't9' });
    const [line] = await through([original]);
    expect(line).toBe(original);
  });

  it('阴控:没有 id 的草案 update 不裹 —— ❌ 别编一个 id 塞进去', async () => {
    // 编一个 id = 凭空长出一条顶层行,正是这个 issue 要修的泄露。
    const original = notify({ sessionUpdate: 'async_task_progress', summary: '半路' });
    const [line] = await through([original]);
    expect(line).toBe(original);
  });

  it('跨 chunk 断开的一行也能正确改写', async () => {
    // ndjson 的一行可能被管道切成两块;按行缓冲没做对的话这里会静默丢事件。
    const encoder = new TextEncoder();
    const whole = notify({
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'kid',
      state: 'completed',
    });
    const cut = Math.floor(whole.length / 2);
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(whole.slice(0, cut)));
        controller.enqueue(encoder.encode(whole.slice(cut) + '\n'));
        controller.close();
      },
    });

    const [line] = await drain(rewriteDraftSessionUpdates(split));
    const update = JSON.parse(line).params.update;
    expect(update._meta[DRAFT_UPDATE_META_KEY].state).toBe('completed');
  });

  it('不是 JSON 的行原样放行,❌ 不吞掉', async () => {
    const [line] = await through(['session/update 但这行不是 JSON']);
    expect(line).toBe('session/update 但这行不是 JSON');
  });
});

/**
 * #5381 ③ —— 压缩的两种草案 update 同样要过这道信封。
 *
 * 与 #5117 同一个坑:已发布的 `@agentclientprotocol/sdk`(0.22.1 实查)联合里没有它们,
 * 不裹信封就在进门时被 `-32602` 整条扔掉 —— 症状是「功能没做」,而不是任何报错。
 */
describe('#5381 压缩 update 的进门信封', () => {
  it('compaction_update 被裹进信封,原件留在 _meta 里', async () => {
    const [line] = await through([
      notify({ sessionUpdate: 'compaction_update', compactionId: 'cmp_001', status: 'completed' }),
    ]);
    const update = (JSON.parse(line!) as { params: { update: Record<string, unknown> } }).params
      .update;
    expect(update.sessionUpdate).toBe('tool_call_update');
    // 信封的 toolCallId 取压缩号 —— 它是这条 update 身上唯一稳定的 id。
    expect(update.toolCallId).toBe('cmp_001');
    expect((update._meta as Record<string, unknown>)[DRAFT_UPDATE_META_KEY]).toMatchObject({
      sessionUpdate: 'compaction_update',
      compactionId: 'cmp_001',
      status: 'completed',
    });
  });

  it('compaction_summary_chunk 同样过信封', async () => {
    const [line] = await through([
      notify({
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'cmp_001',
        content: { type: 'text', text: '## 保留' },
      }),
    ]);
    const update = (JSON.parse(line!) as { params: { update: Record<string, unknown> } }).params
      .update;
    expect(update.toolCallId).toBe('cmp_001');
    expect((update._meta as Record<string, unknown>)[DRAFT_UPDATE_META_KEY]).toMatchObject({
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'cmp_001',
    });
  });
})

/**
 * #6596 —— 供应商提示 `notice` 同样要过信封(SDK 1.5.0 才进联合,咕咕钉的 1.4.0 没有)。
 * 它协议上没有 id:信封的 toolCallId 只是填位,所以要连解码一起钉 —— 拆开必须是 notice,❌ 落进工具分支长出一行。
 */
describe('#6596 notice 的进门信封', () => {
  it('notice 裹进信封,解码拆出来是 session_notice', async () => {
    const [line] = await through([
      notify({ sessionUpdate: 'notice', severity: 'info', title: 'Task stopped by user', description: 'sleep 613.' }),
    ]);
    const update = JSON.parse(line!).params.update;
    expect(update.sessionUpdate).toBe('tool_call_update');
    expect(update._meta[DRAFT_UPDATE_META_KEY]).toMatchObject({ sessionUpdate: 'notice', title: 'Task stopped by user' });
    expect(decodeSessionUpdate(update)).toEqual({
      kind: 'session_notice',
      code: 'provider-notice',
      title: 'Task stopped by user',
      detail: 'sleep 613.',
    });
  });

  it('坏掉的 notice(没有 title)也 ❌ 交回工具分支', async () => {
    const [line] = await through([notify({ sessionUpdate: 'notice', severity: 'warning' })]);
    expect(decodeSessionUpdate(JSON.parse(line!).params.update)).toEqual({ kind: 'ignored' });
  });
});
