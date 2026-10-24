import { Writable } from 'node:stream';
import type {
  AuthMethod,
  InitializeRequest,
  InitializeResponse,
  McpServer,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
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
 * Prompt responses are native message receipts. Foreground idle is delivered independently;
 * neither receipt order nor the number of requests defines a foreground cycle.
 *
 * Config options and commands still map their setup shapes. Message, plan, patch and terminal
 * entities pass through unchanged; the host owns their presentation snapshots.
 */
export function connectStdioAcpV2(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  const stream = v2.ndJsonStream(
    Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
    nodeReadableToWeb(io.stdout),
  );
  const deliver = (notification: SessionNotification) => client.sessionUpdate(notification);

  const app = v2
    .client({ name: 'gugu' })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      const { sessionId, update } = params;
      for (const normalized of v1Updates(update)) void deliver({ sessionId, update: normalized });
    })
    .onRequest(v2.methods.client.session.requestPermission, async ({ params }) =>
      client.requestPermission(params),
    );
  const connection = app.connect(stream);
  const agent = connection.agent;

  const api: AcpAgentApi = {
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
    async prompt(params, dispatch) {
      const receipt = await agent.request(v2.methods.agent.session.prompt, params as v2.PromptRequest);
      return { status: 'accepted', requestId: dispatch?.requestId ?? crypto.randomUUID(), ...receipt };
    },
    cancel: (params) => agent.notify(v2.methods.agent.session.cancel, params),
    async steer(params) {
      const response = await agent.request<Record<string, unknown>>('_session/steering', {
        ...params, _meta: { steering: { idleBehavior: 'promptRequired', delivery: 'next' } },
      });
      if (response.outcome === 'injected' || response.outcome === 'promptRequired') return response.outcome;
      throw new Error(`ACP steering returned unsupported outcome '${String(response.outcome)}'`);
    },
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
      _meta: { ...capabilities?._meta, asyncTasks: {} },
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
