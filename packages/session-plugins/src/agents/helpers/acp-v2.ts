import { Writable } from 'node:stream';
import type {
  AuthMethod,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpAgentApi, AcpClientFactory, AcpProcessIo } from '@gugu/session-core/agents/plugins';
import { nodeReadableToWeb } from './acp-stdio';

/**
 * ACP v2 over stdio, behind the same `AcpAgentApi` the host drives every adapter through.
 *
 * Protocol only: nothing here knows which harness is on the other end. The extensions the host
 * uses on any adapter (`_session/steering`, `_session/async_task/stop`) are plain extension
 * requests (`extMethod`), and their updates pass through unchanged.
 *
 * The one place v2 changes what the host relies on is the end of a turn. v1 answers
 * `session/prompt` when the turn ends; v2 answers it once the agent takes the prompt in, and the
 * turn ends at the session's next foreground `idle`, which carries the stop reason, usage and
 * error. `prompt()` resolves at that idle, so the host's turn contract (prompt in, outcome out)
 * holds on both versions. An adapter that keeps doing background work (a subagent) reports it
 * after `idle`; the host is free to send the next prompt from there.
 *
 * Config options and commands still map their setup shapes. Message, plan, patch and terminal
 * entities pass through unchanged; the host owns their presentation snapshots.
 */
export function connectStdioAcpV2(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  const stream = v2.ndJsonStream(
    Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
    nodeReadableToWeb(io.stdout),
  );
  const turns = new PromptTurns();
  const deliver = (notification: SessionNotification) => client.sessionUpdate(notification);

  const app = v2
    .client({ name: 'gugu' })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      const { sessionId, update } = params;
      let v1: SessionUpdate[];
      try {
        v1 = v1Updates(update);
      } catch (error) {
        // An update the host cannot show ends the session's turns with that error, loudly.
        turns.failed(sessionId, error);
        throw error;
      }
      for (const v1Update of v1) {
        void deliver({ sessionId, update: v1Update });
      }
      // After the update went to the client: the host reads the idle before the prompt's outcome.
      turns.observe(sessionId, update);
    })
    .onRequest(v2.methods.client.session.requestPermission, async ({ params }) =>
      client.requestPermission(params),
    );
  const connection = app.connect(stream);
  const agent = connection.agent;
  void connection.closed.then(() => turns.closed());

  const api: AcpAgentApi = {
    protocolVersion: 2,
    // The SDK's v2 client refuses an agent that answers another version: initialize fails loudly.
    initialize: async (params) =>
      v1InitializeResponse(await agent.request(v2.methods.agent.initialize, v2InitializeRequest(params))),
    async newSession(params) {
      const { mcpServers, ...rest } = params;
      const response = await agent.request(v2.methods.agent.session.new, {
        ...rest,
        mcpServers: mcpServers.map(v2McpServer),
      });
      announceCommands(response.sessionId, response.availableCommands);
      return { sessionId: response.sessionId, ...v1SetupResponse(response) };
    },
    async loadSession(params) {
      const { mcpServers, ...rest } = params;
      const response = await agent.request(v2.methods.agent.session.resume, {
        ...rest,
        mcpServers: mcpServers.map(v2McpServer),
        replayFrom: { type: 'start' },
      });
      announceCommands(params.sessionId, response.availableCommands);
      return v1SetupResponse(response);
    },
    async unstable_forkSession(params) {
      const { mcpServers, ...rest } = params;
      const response = await agent.request(v2.methods.agent.session.fork, {
        ...rest,
        ...(mcpServers ? { mcpServers: mcpServers.map(v2McpServer) } : {}),
      });
      announceCommands(response.sessionId, response.availableCommands);
      return { sessionId: response.sessionId, ...v1SetupResponse(response) };
    },
    listSessions: (params) => agent.request(v2.methods.agent.session.list, params),
    async prompt(params) {
      const turn = turns.open(params.sessionId);
      try {
        await agent.request(v2.methods.agent.session.prompt, params as v2.PromptRequest);
      } catch (error) {
        turns.refused(params.sessionId, turn);
        // A queued prompt that a cancel ended before the agent took it in is a cancelled turn.
        if ((error as { code?: unknown } | null)?.code === -32800) return { stopReason: 'cancelled' };
        throw error;
      }
      return turn.promise;
    },
    cancel: (params) => agent.notify(v2.methods.agent.session.cancel, params),
    extMethod: (method, params) => agent.request<Record<string, unknown>>(method as v2.ExtensionMethod, params),
    async setSessionConfigOption(params) {
      // v2 tags every value; v1 tags only the boolean one.
      const response = await agent.request(v2.methods.agent.session.setConfigOption, {
        type: 'id',
        ...params,
      } as v2.SetSessionConfigOptionRequest);
      return { ...response, configOptions: v1ConfigOptions(response.configOptions ?? []) };
    },
    closeSession: (params) => agent.request(v2.methods.agent.session.close, params),
  };
  // The handlers above run only once messages arrive, after this line.
  const client = toClient(api);

  /** v2 lists the session's commands in the setup response; the host takes them as an update. */
  function announceCommands(sessionId: string, commands: v2.AvailableCommand[] | null | undefined): void {
    if (!commands?.length) return;
    // After the setup response, as a v1 agent sends it: the host routes the session from there.
    setTimeout(() => {
      void deliver({ sessionId, update: v1CommandsUpdate(commands) });
    }, 0);
  }

  return api;
}

/**
 * The prompts of a connection that wait for their turn to end, by session, in the order they were
 * sent (an agent takes them in in that order; a prompt sent while another runs waits in the agent).
 *
 * A prompt's turn starts when the agent takes the prompt in (its `user_message`) and ends at the
 * next `idle` of that session. An `idle` before the prompt was taken in ends earlier work (a cycle
 * the agent ran on its own, or the turn of an earlier prompt), not this prompt's. A prompt taken in
 * while an earlier one runs joins that work, and both end at its `idle`.
 */
class PromptTurns {
  private readonly bySession = new Map<string, PendingTurn[]>();

  open(sessionId: string): PendingTurn {
    const turn = pendingTurn();
    this.bySession.set(sessionId, [...(this.bySession.get(sessionId) ?? []), turn]);
    return turn;
  }

  refused(sessionId: string, turn: PendingTurn): void {
    const rest = (this.bySession.get(sessionId) ?? []).filter((pending) => pending !== turn);
    if (rest.length > 0) this.bySession.set(sessionId, rest);
    else this.bySession.delete(sessionId);
  }

  observe(sessionId: string, update: v2.SessionUpdate): void {
    const pending = this.bySession.get(sessionId);
    if (!pending) return;
    if (update.sessionUpdate === 'user_message') {
      const next = pending.find((turn) => !turn.inserted);
      if (next) next.inserted = true;
      return;
    }
    if (update.sessionUpdate !== 'state_update' || update.state !== 'idle') return;
    const ended = pending.filter((turn) => turn.inserted);
    if (ended.length === 0) return;
    const waiting = pending.filter((turn) => !turn.inserted);
    if (waiting.length > 0) this.bySession.set(sessionId, waiting);
    else this.bySession.delete(sessionId);
    const idle = update as v2.IdleStateUpdate & { usage?: unknown; _meta?: Record<string, unknown> | null };
    for (const turn of ended) {
      if (idle.stopReason === 'error') {
        turn.reject((idle as { error?: unknown }).error ?? new Error('The turn ended with an error'));
        continue;
      }
      turn.resolve({
        stopReason: (idle.stopReason ?? 'end_turn') as StopReason,
        ...(idle.usage ? { usage: idle.usage as PromptResponse['usage'] } : {}),
        ...(idle._meta ? { _meta: idle._meta } : {}),
      });
    }
  }

  failed(sessionId: string, error: unknown): void {
    for (const turn of this.bySession.get(sessionId) ?? []) turn.reject(error);
    this.bySession.delete(sessionId);
  }

  closed(): void {
    for (const turns of this.bySession.values()) for (const turn of turns) turn.reject(new Error('ACP connection closed'));
    this.bySession.clear();
  }
}

type PendingTurn = PromiseWithResolvers<PromptResponse> & { inserted: boolean };

function pendingTurn(): PendingTurn {
  const turn = { ...Promise.withResolvers<PromptResponse>(), inserted: false };
  // The outcome is read only once the agent took the prompt in; a failure before that is the
  // request's own, so this one must not surface as unhandled.
  turn.promise.catch(() => {});
  return turn;
}

/** Standard entity updates cross the transport boundary unchanged. */
function v1Updates(update: v2.SessionUpdate): SessionUpdate[] {
  switch (update.sessionUpdate) {
    case 'config_option_update': {
      const { configOptions } = update as v2.ConfigOptionUpdate;
      return [{ ...update, configOptions: v1ConfigOptions(configOptions) } as SessionUpdate];
    }
    case 'available_commands_update':
      return [v1CommandsUpdate((update as v2.AvailableCommandsUpdate).availableCommands)];
    case 'user_message':
      // Prompt insertion is still owned by the cell until the receipt/foreground step.
      return [];
    case 'agent_message':
    case 'agent_thought':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call_content_chunk':
    case 'plan_update':
    case 'plan_removed':
      return [update as unknown as SessionUpdate];
    default:
      return [update as unknown as SessionUpdate];
  }
}

function v1CommandsUpdate(commands: v2.AvailableCommand[]): SessionUpdate {
  return {
    sessionUpdate: 'available_commands_update',
    availableCommands: commands.map(({ input, ...command }) => ({
      ...command,
      ...(input ? { input: { hint: (input as { hint: string }).hint } } : {}),
    })),
  } as SessionUpdate;
}

function v1ConfigOptions(options: v2.SessionConfigOption[]): SessionConfigOption[] {
  return options.map((option) => {
    const { configId, ...rest } = option as v2.SessionConfigOption & { options?: unknown[] };
    const select = Array.isArray(rest.options)
      ? {
          options: rest.options.map((entry) => {
            const { groupId, ...group } = entry as { groupId?: string };
            return groupId === undefined ? entry : { ...group, group: groupId };
          }),
        }
      : {};
    return { ...rest, ...select, id: configId } as unknown as SessionConfigOption;
  });
}

function v1SetupResponse(response: { configOptions?: v2.SessionConfigOption[] | null; _meta?: Record<string, unknown> | null }) {
  return {
    ...(response.configOptions ? { configOptions: v1ConfigOptions(response.configOptions) } : {}),
    ...(response._meta ? { _meta: response._meta } : {}),
  };
}

/** v2 tags every transport; v1's stdio server has none. v2 has no SSE transport. */
function v2McpServer(server: McpServer): v2.McpServer {
  if ('type' in server && server.type === 'sse') {
    throw new Error(`MCP server ${server.name}: ACP v2 has no SSE transport`);
  }
  if ('type' in server && server.type === 'http') return server as v2.McpServer;
  return { ...(server as Extract<McpServer, { command: string }>), type: 'stdio' } as v2.McpServer;
}

/** The v2 `initialize` for the host's request: v2 has no client file system or terminals. */
function v2InitializeRequest(request: InitializeRequest): v2.InitializeRequest {
  const capabilities = request.clientCapabilities;
  return {
    protocolVersion: 2,
    info: request.clientInfo ?? { name: 'gugu', version: '1' },
    capabilities: {
      ...(capabilities?.auth?.terminal ? { auth: { terminal: {} } } : {}),
      ...(capabilities?._meta ? { _meta: capabilities._meta } : {}),
    },
    ...(request._meta ? { _meta: request._meta } : {}),
  };
}

/** The host reads a v1 `initialize` response; a v2 agent resumes a session with its history. */
function v1InitializeResponse(response: v2.InitializeResponse): InitializeResponse {
  const session = response.capabilities?.session;
  return {
    protocolVersion: response.protocolVersion,
    agentInfo: response.info,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: session?.prompt?.image != null,
        embeddedContext: session?.prompt?.embeddedContext != null,
      },
      sessionCapabilities: {
        ...(session?.fork ? { fork: {} } : {}),
        // `session/list` and `session/close` are v2's baseline.
        close: {},
        list: {},
      },
      ...(response.capabilities?._meta ? { _meta: response.capabilities._meta } : {}),
    },
    authMethods: (response.authMethods ?? []).map(v1AuthMethod),
    ...(response._meta ? { _meta: response._meta } : {}),
  } as InitializeResponse;
}

function v1AuthMethod(method: v2.AuthMethod): AuthMethod {
  const { methodId, env, ...rest } = method as v2.AuthMethod & { env?: { name: string; value: string }[] };
  return {
    ...rest,
    id: methodId,
    ...(env ? { env: Object.fromEntries(env.map(({ name, value }) => [name, value])) } : {}),
  } as AuthMethod;
}
