import { Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { decodePermissionRequest, decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionNotification } from '@agentclientprotocol/sdk';
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

// The v1 SDK rejects these negotiated extensions before its notification callback.
// Route them directly to domain decoding; never fabricate a tool notification.
const LEGACY_SESSION_UPDATES = new Set([
  'subagent_spawned', 'subagent_state_update', 'async_task_spawned',
  'async_task_progress', 'async_task_state_update', 'compaction_update',
  'compaction_summary_chunk', 'notice',
]);

export function routeLegacySessionUpdates(
  source: ReadableStream<Uint8Array>,
  deliver: (notification: SessionNotification) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const routeLine = (line: string): string | null => {
    let message: { method?: string; params?: SessionNotification };
    try { message = JSON.parse(line) as typeof message; } catch { return line; }
    const params = message.params;
    const update = params?.update as unknown as Record<string, unknown> | undefined;
    if (message.method !== 'session/update' || !params || !update
      || !LEGACY_SESSION_UPDATES.has(String(update.sessionUpdate))) return line;
    const id = update.subagentSessionId ?? update.asyncTaskId ?? update.compactionId;
    // Malformed frames keep the SDK's loud rejection rather than becoming ignored events.
    if (typeof params.sessionId !== 'string'
      || (update.sessionUpdate !== 'notice' && (typeof id !== 'string' || !id))) return line;
    deliver(params);
    return null;
  };
  let buffered = '';
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const routed = routeLine(line);
        if (routed !== null) controller.enqueue(encoder.encode(routed + '\n'));
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) {
        const routed = routeLine(buffered);
        if (routed !== null) controller.enqueue(encoder.encode(routed));
      }
    },
  }));
}

export function connectStdioAcp(io: AcpProcessIo, toClient: AcpClientFactory, options: { interruptAtToolBoundary?: boolean } = {}): AcpAgentApi {
  let client: ReturnType<AcpClientFactory>;
  let boundary: ReturnType<typeof createRequestActivity>;
  const deliver = (params: SessionNotification): void => {
    const event = decodeSessionUpdate(params.update);
    if (event.kind === 'tool_call' || event.kind === 'tool_update') boundary.observe(params.sessionId, event);
    client.sessionEvent({ sessionId: params.sessionId, event, trace: params.update });
  };
  const stream = ndJsonStream(
    Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
    routeLegacySessionUpdates(nodeReadableToWeb(io.stdout), deliver),
  );
  new ClientSideConnection((agent) => {
    boundary = createRequestActivity(agent as ClientSideConnection, params => client.sessionEvent(params), options);
    client = toClient(boundary.agent);
    return { ...client, sessionUpdate: deliver, requestPermission: params => client.requestPermission(decodePermissionRequest(params)) };
  }, stream);
  const api = boundary!.agent;
  const initialize = api.initialize;
  // AIR belongs only to the v1 wire handshake.
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
