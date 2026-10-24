import { Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { DRAFT_UPDATE_META_KEY } from '@gugu/session-core/acp';
import { createRequestActivity } from '@gugu/session-core/acp';
import type {
  AcpAgentApi,
  AcpClientFactory,
  AcpProcessIo,
  AcpSpawnContext,
  AcpSpawnResult,
  IAcpBehavior,
} from '@gugu/session-core/agents/plugins';

type NativeAcpSpawnResult = Omit<AcpSpawnResult, 'command'> & {
  command?: string;
};

// 信封键的**唯一**出处在解码那侧(session-core)。这里只读不定义 —— 两处各写一份会漂移,
// 而漂移的症状是「事件静默消失」,最难查的那一种(#5117)。

/** SDK 1.3.0 的联合里没有、但谈成能力后 agent 真会发的那几种(agent-client-protocol#1992)。 */
const DRAFT_SESSION_UPDATES = new Set([
  'subagent_spawned',
  'subagent_state_update',
  'async_task_spawned',
  'async_task_progress',
  'async_task_state_update',
  // 上下文压缩（ACP `session-compaction` RFD）。与上面五种同一个处境:已发布的 SDK
  // （0.22.1 实查）联合里没有它们,不裹信封就在进门时被 -32602 扔掉。
  'compaction_update',
  'compaction_summary_chunk',
  // 供应商提示:SDK 1.5.0 才进联合;1.9 的联合要求 `severity`,v1 的家发的不一定带。
  'notice',
]);

function draftUpdateId(update: Record<string, unknown>): string | undefined {
  // notice 没有 id,填位即可:解码那侧先认出 notice,绝不交给工具分支。
  if (update.sessionUpdate === 'notice') return 'notice';
  const id = update.subagentSessionId ?? update.asyncTaskId ?? update.compactionId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * 把草案 update 裹进一条 SDK 认得的信封,**否则它在进门时就被扔掉**(#5117)。
 *
 * 症状很像「功能没做」:agent 侧一切正常,客户端却什么都收不到。真相在运行时 stderr:
 * `Error handling notification … subagent_spawned … {code:-32602, message:'Invalid params'}`
 * —— `ClientSideConnection` 对进来的 `session/update` 做**运行时 zod 校验**,而 1.3.0 的
 * 联合里没有这几种。上游适配器在**发送侧**用 `asSdkSessionNotification()` 强转绕过类型,
 * 接收侧没有对应的口子,构造函数也不收放宽校验的选项(只有 `(toClient, stream)`)。
 * ⇒ 只能在**进 SDK 之前**改写,也就是这里。
 *
 * ⚠️ 后果不只是「少显示一点」:这几条被拒之后子智能体的完成事件永远到不了,那一轮不收口、
 * 模型被反复叫醒 —— owner 2026-09-06 实测一次派发回了三条「收到」。
 *
 * ⚠️ 信封用 `tool_call_update`,但**必须**在 `decodeSessionUpdate` 里先按 `_meta` 认出来:
 * 它带的 `toolCallId` 是子会话号/任务号,根转录不认识,落进普通 tool_call_update 分支就会
 * 长出一条凭空多出来的顶层行 —— 那正是这个 issue 要修的泄露。
 *
 * 到期条件:SDK 发布 #1992(`SessionNotification` 的联合里出现这几种)后整个删掉。
 */
export function rewriteDraftSessionUpdates(
  source: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';

  const rewriteLine = (line: string): string => {
    if (!line.includes('session/update')) return line;
    let message: { method?: unknown; params?: { update?: Record<string, unknown> } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // ❌ 不是我们能解析的就原样放行 —— 由 SDK 去报它自己的错,别在这里吞掉。
      return line;
    }
    const update = message?.params?.update;
    if (message.method !== 'session/update' || !update) return line;
    if (typeof update.sessionUpdate !== 'string') return line;
    if (!DRAFT_SESSION_UPDATES.has(update.sessionUpdate)) return line;

    const id = draftUpdateId(update);
    // 没有 id 就没法给信封填一个合法的 toolCallId。原样放行 = SDK 照旧拒绝并在 stderr 留痕,
    // ❌ 别编一个 id 把它塞进去:那会凭空长出一条顶层行。
    if (!id) return line;

    message.params!.update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      _meta: { [DRAFT_UPDATE_META_KEY]: update },
    };
    return JSON.stringify(message);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            controller.enqueue(encoder.encode(rewriteLine(line) + '\n'));
          }
        }
        if (buffered) controller.enqueue(encoder.encode(rewriteLine(buffered)));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function connectStdioAcp(io: AcpProcessIo, toClient: AcpClientFactory, options: { interruptAtToolBoundary?: boolean } = {}): AcpAgentApi {
  const stream = ndJsonStream(
    Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
    rewriteDraftSessionUpdates(nodeReadableToWeb(io.stdout))
  );
  let boundary!: ReturnType<typeof createRequestActivity>;
  new ClientSideConnection((agent) => {
    // SDK 1.9.0 calls toClient(this), but widens that callback's parameter to Agent/MaybePromise.
    boundary = createRequestActivity(agent as ClientSideConnection, params => client.sessionEvent(params), options);
    const client = toClient(boundary.agent);
    return { ...client, sessionUpdate: params => {
      const update = params.update;
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        boundary.observe(params.sessionId, { kind: update.sessionUpdate === 'tool_call' ? 'tool_call' : 'tool_update',
          toolCallId: update.toolCallId, status: update.status });
      }
      return client.sessionUpdate(params);
    } };
  }, stream);
  const api = boundary.agent;
  const initialize = api.initialize;
  // This extension belongs only to the v1 wire handshake.
  return new Proxy(api, { get(target, property) {
    if (property === 'initialize') return (params: Parameters<AcpAgentApi['initialize']>[0]) => initialize({
      ...params,
      clientCapabilities: { ...params.clientCapabilities, _meta: {
        ...params.clientCapabilities?._meta,
        jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } },
      } },
    });
    return Reflect.get(target, property);
  } });
}

export function nodeReadableToWeb(source: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  let settled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onData = (chunk: Buffer | Uint8Array | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Uint8Array.from(chunk);
        controller.enqueue(bytes);
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      };
      const onEnd = () => finish(() => controller.close());
      const onError = (error: Error) => finish(() => controller.error(error));
      cleanup = () => {
        source.off('data', onData);
        source.off('end', onEnd);
        source.off('error', onError);
      };
      source.on('data', onData);
      source.once('end', onEnd);
      source.once('error', onError);
    },
    pull() {
      source.resume();
    },
    cancel(reason) {
      if (settled) return;
      settled = true;
      cleanup();
      const destroy = (source as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
      destroy?.call(source, reason instanceof Error ? reason : undefined);
    },
  });
}

export function createNativeAcpBehavior(
  buildSpawn: (ctx: AcpSpawnContext) => NativeAcpSpawnResult,
  options: { interruptAtToolBoundary?: boolean } = {},
): IAcpBehavior {
  return {
    buildSpawn: (ctx) => {
      const spawn = buildSpawn(ctx);
      return {
        command: spawn.command ?? ctx.cli,
        args: spawn.args,
        env: spawn.env,
      };
    },
    connect: (io, toClient) => connectStdioAcp(io, toClient, options),
  };
}
