import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SessionUpdate, SessionConfigOption, NewSessionResponse, ToolCallContent } from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk-v2/experimental/v2/unstable';
import { parsePatch } from 'diff';
import type { AcpAgentApi, AcpClientFactory, AcpProcessIo } from '@gugu/session-core/agents/plugins';

/** The shared wire-v2 boundary. The runtime consumes the same domain vocabulary
 * for every harness, while prompt admission retains its distinct response. */
export function connectStdioAcpV2(io: AcpProcessIo, toClient: AcpClientFactory): AcpAgentApi {
  let peer!: v2.ClientContext;
  const modeIds = new Map<string, string>();
  const updates = new V2Updates();
  const ownedMessages = new Set<string>();
  const pendingMessages = new Map<string, v2.UpdateSessionNotification[]>();
  const pendingPrompts = new Map<string, number>();
  const send = async (notification: v2.UpdateSessionNotification) => {
    for (const update of updates.apply(notification)) {
      await client.sessionUpdate({ sessionId: notification.sessionId, update });
    }
  };
  const setup = (sessionId: string, response: v2.ResumeSessionResponse) => {
    const configOptions = configOptionsForRuntime(response.configOptions ?? []);
    const mode = configOptions.find((option) => option.category === 'mode');
    if (mode) modeIds.set(sessionId, mode.id);
    if (response.availableCommands) {
      setImmediate(() => void client.sessionUpdate({ sessionId, update: {
        sessionUpdate: 'available_commands_update', availableCommands: response.availableCommands as never,
      } }));
    }
    return { ...response, configOptions };
  };
  const api: AcpAgentApi = {
    protocolVersion: 2,
    async initialize(params) {
      const response = await peer.request(v2.methods.agent.initialize, {
        protocolVersion: 2,
        info: params.clientInfo ?? { name: 'gugu', version: '1' },
        capabilities: { auth: { terminal: {} }, _meta: { ...params.clientCapabilities?._meta, asyncTasks: true } },
      });
      if (response.protocolVersion !== 2) throw new Error(`ACP v2 required; agent negotiated ${response.protocolVersion}`);
      return {
        protocolVersion: response.protocolVersion,
        agentInfo: response.info,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: response.capabilities?.session?.prompt?.image != null, embeddedContext: response.capabilities?.session?.prompt?.embeddedContext != null },
          sessionCapabilities: { ...(response.capabilities?.session?.fork ? { fork: {} } : {}), list: {} },
          _meta: response.capabilities?._meta,
        },
        authMethods: (response.authMethods ?? []).map(({ methodId, ...method }) => ({
          ...method, id: methodId,
          ...('env' in method && Array.isArray(method.env) ? { env: Object.fromEntries(method.env.map(({ name, value }) => [name, value])) } : {}),
        })) as never,
        _meta: response._meta,
      };
    },
    async newSession(params) {
      const response = await peer.request(v2.methods.agent.session.new, params as unknown as v2.NewSessionRequest);
      return { sessionId: response.sessionId, ...setup(response.sessionId, response) } as NewSessionResponse;
    },
    async loadSession(params) {
      updates.forget(params.sessionId);
      for (const key of ownedMessages) if (key.startsWith(`${params.sessionId}\0`)) ownedMessages.delete(key);
      const response = await peer.request(v2.methods.agent.session.resume, { ...params, replayFrom: { type: 'start' } } as unknown as v2.ResumeSessionRequest);
      return setup(params.sessionId, response);
    },
    async unstable_forkSession(params) {
      const response = await peer.request(v2.methods.agent.session.fork, params as unknown as v2.ForkSessionRequest);
      return { sessionId: response.sessionId, ...setup(response.sessionId, response) };
    },
    async prompt(params) {
      const sessionId = params.sessionId;
      pendingPrompts.set(sessionId, (pendingPrompts.get(sessionId) ?? 0) + 1);
      try {
        const response = await peer.request(v2.methods.agent.session.prompt, params as unknown as v2.PromptRequest);
        // Match the protocol receipt, never the text. The cell already recorded
        // the local user row; replayed and externally authored rows still flow.
        ownedMessages.add(`${sessionId}\0${response.messageId}`);
        return response;
      } finally {
        const count = (pendingPrompts.get(sessionId) ?? 1) - 1;
        if (count) pendingPrompts.set(sessionId, count);
        else {
          pendingPrompts.delete(sessionId);
          const buffered = pendingMessages.get(sessionId) ?? [];
          pendingMessages.delete(sessionId);
          for (const notification of buffered) {
            if (!ownedMessages.has(`${sessionId}\0${(notification.update as { messageId?: string }).messageId}`)) await send(notification);
          }
        }
      }
    },
    cancel: (params) => peer.notify(v2.methods.agent.session.cancel, params),
    listSessions: (params) => peer.request(v2.methods.agent.session.list, params),
    async setSessionConfigOption(params) {
      const response = await peer.request(v2.methods.agent.session.setConfigOption, { ...params, type: 'id' } as v2.SetSessionConfigOptionRequest);
      return { ...response, configOptions: configOptionsForRuntime(response.configOptions) };
    },
    async setSessionMode({ sessionId, modeId }) {
      const response = await peer.request(v2.methods.agent.session.setConfigOption, { sessionId, configId: modeIds.get(sessionId) ?? 'mode', type: 'id', value: modeId });
      return { ...response, configOptions: configOptionsForRuntime(response.configOptions) };
    },
    async closeSession(params) {
      const response = await peer.request(v2.methods.agent.session.close, params);
      modeIds.delete(params.sessionId);
      updates.forget(params.sessionId);
      for (const key of ownedMessages) if (key.startsWith(`${params.sessionId}\0`)) ownedMessages.delete(key);
      return response;
    },
    extMethod(method, params) {
      if (!method.startsWith('_')) throw new Error(`Invalid ACP extension method: ${method}`);
      return peer.request<Record<string, unknown>, Record<string, unknown>>(method as v2.ExtensionMethod, params);
    },
  };
  const client = toClient(api);
  const app = v2.client({ name: 'gugu' })
    .onNotification(v2.methods.client.session.update, async ({ params }) => {
      const { update, sessionId } = params;
      if (update.sessionUpdate === 'user_message') {
        if (ownedMessages.has(`${sessionId}\0${(update as v2.UserMessage).messageId}`)) return;
        if (pendingPrompts.has(sessionId)) {
          const buffered = pendingMessages.get(sessionId) ?? [];
          buffered.push(params);
          pendingMessages.set(sessionId, buffered);
          return;
        }
      }
      await send(params);
    })
    .onNotification('_session/async_task/update', { parse: parseTaskUpdate }, async ({ params }) => {
      await client.sessionUpdate(params);
    })
    .onRequest(v2.methods.client.session.requestPermission, async ({ params }) => {
      if (!params.subject || !v2.RequestPermissionSubject.isToolCall(params.subject)) throw v2.RequestError.invalidParams(undefined, 'Unsupported permission subject');
      const mapped = updates.apply({ sessionId: params.sessionId, update: { ...params.subject.toolCall, sessionUpdate: 'tool_call_update' } });
      for (const update of mapped) await client.sessionUpdate({ sessionId: params.sessionId, update });
      return client.requestPermission({ sessionId: params.sessionId, options: params.options as never, toolCall: { ...mapped[0], title: params.title } as never, _meta: params._meta });
    });
  const connection = app.connect(v2.ndJsonStream(Writable.toWeb(io.stdin) as WritableStream<Uint8Array>, Readable.toWeb(io.stdout) as ReadableStream<Uint8Array>));
  peer = connection.agent;
  // A failed handshake is already returned by initialize; consume the SDK's
  // parallel lifecycle promise so it does not become an unhandled rejection.
  void connection.initialized.catch(() => {});
  return api;
}

function configOptionsForRuntime(options: v2.SessionConfigOption[]): SessionConfigOption[] {
  return options.map((option) => {
    if (!v2.SessionConfigOption.isSelect(option)) {
      const { configId, ...rest } = option;
      return { ...rest, id: configId } as unknown as SessionConfigOption;
    }
    const { configId, options: choices, ...rest } = option;
    return { ...rest, id: configId, options: choices.map((choice) => 'groupId' in choice ? { ...choice, group: choice.groupId } : choice) } as SessionConfigOption;
  });
}

function parseTaskUpdate(value: unknown): { sessionId: string; update: SessionUpdate } {
  const raw = value as { sessionId?: unknown; update?: { sessionUpdate?: unknown; asyncTaskId?: unknown } };
  if (typeof raw?.sessionId !== 'string' || typeof raw.update?.asyncTaskId !== 'string' || !['async_task_spawned', 'async_task_progress', 'async_task_state_update'].includes(String(raw.update.sessionUpdate))) {
    throw v2.RequestError.invalidParams(undefined, 'Invalid async task update');
  }
  return raw as { sessionId: string; update: SessionUpdate };
}

type Entity = Record<string, unknown>;
/** ACP v2 upserts and metadata patches are materialized at the protocol edge. */
class V2Updates {
  private readonly tools = new Map<string, Entity>();
  private readonly children = new Map<string, v2.SubagentUpdate>();
  private readonly childDelegations = new Map<string, string>();
  private readonly terminals = new Map<string, Entity>();
  private readonly terminalTools = new Map<string, string>();
  private readonly terminalDecoders = new Map<string, StringDecoder>();

  forget(sessionId: string): void {
    for (const map of [this.tools, this.terminals, this.terminalTools, this.terminalDecoders]) for (const key of map.keys()) if (key.startsWith(`${sessionId}\0`)) map.delete(key);
    for (const key of this.children.keys()) if (key.startsWith(`${sessionId}\0`)) { this.children.delete(key); this.childDelegations.delete(key); }
  }

  tool(sessionId: string, patch: v2.ToolCallUpdate): Entity {
    const key = `${sessionId}\0${patch.toolCallId}`;
    const previous = this.tools.get(key) ?? {};
    const meta = patchedMetadata(previous._meta, patch._meta);
    const tool = { ...previous, ...patch, _meta: meta };
    if (typeof tool.name === 'string') meta.toolName = tool.name;
    else if (patch.name === null) delete meta.toolName;
    this.tools.set(key, tool);
    return tool;
  }

  apply({ sessionId, update }: v2.UpdateSessionNotification): SessionUpdate[] {
    const raw = update as unknown as Entity;
    const asUpdates = (items: Entity[]): SessionUpdate[] => items as unknown as SessionUpdate[];
    switch (update.sessionUpdate) {
      case 'tool_call_update': {
        const patch = update as v2.ToolCallUpdate;
        const tool = this.tool(sessionId, patch);
        if (patch.content !== undefined) {
          for (const [key, owner] of this.terminalTools) {
            if (owner === patch.toolCallId && key.startsWith(`${sessionId}\0`)) this.terminalTools.delete(key);
          }
        }
        const content = (tool.content as v2.ToolCallContent[] | null | undefined)?.flatMap<ToolCallContent>((item) => {
          if (v2.ToolCallContent.isTerminal(item)) {
            const terminalKey = `${sessionId}\0${item.terminalId}`;
            this.terminalTools.set(terminalKey, patch.toolCallId);
            return [item];
          }
          if (v2.ToolCallContent.isDiff(item)) {
            return diffContentForRuntime(item);
          }
          return [item as ToolCallContent];
        });
        return asUpdates([{ ...tool, sessionUpdate: 'tool_call', title: tool.title ?? tool.name ?? patch.toolCallId, status: tool.status === 'cancelled' ? 'failed' : tool.status, content, _meta: { ...tool._meta as Entity, entitySnapshot: true } }, ...this.terminalReports(sessionId, patch.toolCallId)]);
      }
      case 'subagent_update': {
        const patch = update as v2.SubagentUpdate;
        const key = `${sessionId}\0${patch.sessionId}`;
        const previous = this.children.get(key);
        const child = { ...previous, ...patch, _meta: patchedMetadata(previous?._meta, patch._meta) };
        this.children.set(key, child);
        if (typeof child._meta?.delegationToolCallId === 'string') this.childDelegations.set(key, child._meta.delegationToolCallId);
        const items: Entity[] = [];
        if (!previous || patch.title !== undefined || patch.description !== undefined || patch.capabilities !== undefined || patch._meta !== undefined) {
          const delegation = this.childDelegations.get(key);
          items.push({ sessionUpdate: 'subagent_spawned', subagentSessionId: child.sessionId, name: child.title, task: child.description, capabilities: { cancel: child.capabilities?.cancel != null }, background: true,
            ...(typeof delegation === 'string' ? { launchToolCallId: delegation, associationOnly: true } : {}) });
        }
        if (patch.state !== undefined) {
          const state = child.state as { state: string; stopReason?: string } | null;
          const activity = state?.state === 'running' || state?.state === 'requires_action'
            ? 'running'
            : state?.state !== 'idle' || !state.stopReason ? 'disconnected'
              : state.stopReason === 'cancelled' ? 'cancelled'
                : state.stopReason === 'error' ? 'failed' : 'completed';
          items.push({ sessionUpdate: 'subagent_state_update', subagentSessionId: child.sessionId, state: activity, canCancel: child.capabilities?.cancel != null });
        }
        return asUpdates(items);
      }
      case 'terminal_update':
      case 'terminal_output_chunk': {
        const key = `${sessionId}\0${raw.terminalId}`;
        const terminal = this.terminals.get(key) ?? {};
        if (update.sessionUpdate === 'terminal_update') {
          Object.assign(terminal, raw);
          if (raw.output !== undefined) {
            const decoder = new StringDecoder('utf8');
            this.terminalDecoders.set(key, decoder);
            terminal.text = raw.output ? decoder.write(Buffer.from((raw.output as { data: string }).data, 'base64')) : '';
          }
          if (raw.exitStatus) terminal.text = String(terminal.text ?? '') + (this.terminalDecoders.get(key)?.end() ?? '');
        } else {
          const decoder = this.terminalDecoders.get(key) ?? new StringDecoder('utf8');
          this.terminalDecoders.set(key, decoder);
          terminal.text = String(terminal.text ?? '') + decoder.write(Buffer.from(String(raw.data), 'base64'));
        }
        this.terminals.set(key, terminal);
        const toolCallId = this.terminalTools.get(key);
        return asUpdates(toolCallId ? this.terminalReports(sessionId, toolCallId) : []);
      }
      case 'agent_message':
      case 'agent_thought':
      case 'user_message': {
        if (raw.content === undefined) return [];
        const text = ((raw.content ?? []) as v2.ContentBlock[]).filter(v2.ContentBlock.isText).map((block) => block.text).join('');
        return asUpdates([{ ...raw, sessionUpdate: `${update.sessionUpdate}_chunk`, content: { type: 'text', text }, _meta: { ...raw._meta as Entity, messageSnapshot: true } }]);
      }
      case 'config_option_update':
        return asUpdates([{ ...raw, configOptions: configOptionsForRuntime(raw.configOptions as v2.SessionConfigOption[]) }]);
      case 'plan_update': {
        const plan = raw.plan as { type: string; entries?: unknown };
        return plan.type === 'items' ? asUpdates([{ sessionUpdate: 'plan', entries: plan.entries }]) : [];
      }
      case 'plan_removed':
      case 'session_message':
      case 'session_message_chunk':
        return [];
      default:
        return asUpdates([raw]);
    }
  }

  private terminalReports(sessionId: string, toolCallId: string): Entity[] {
    const reports: Entity[] = [];
    for (const [key, owner] of this.terminalTools) {
      if (owner !== toolCallId || !key.startsWith(`${sessionId}\0`)) continue;
      const terminal = this.terminals.get(key);
      if (!terminal) continue;
      const exit = terminal.exitStatus as { exitCode?: number; signal?: string } | undefined;
      reports.push({ sessionUpdate: 'tool_call_update', toolCallId, rawOutput: terminal.text ?? '', ...(exit ? { _meta: { terminal_exit: { terminal_id: terminal.terminalId, exit_code: exit.exitCode ?? null, signal: exit.signal ?? null } } } : {}) });
    }
    return reports;
  }
}

function patchedMetadata(previous: unknown, patch: Entity | null | undefined): Entity {
  const meta: Entity = patch === null ? {} : { ...previous as Entity };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete meta[key]; else meta[key] = value;
  }
  return meta;
}

/** The transcript displays changed regions, not whole-file snapshots. A v2
 * git patch supplies those regions without reading the agent's filesystem. */
function diffContentForRuntime(diff: v2.Diff): ToolCallContent[] {
  const patches = diff.patch?.format === 'git_patch' ? parsePatch(diff.patch.text) : [];
  return diff.changes.flatMap((change): ToolCallContent[] => {
    const patch = patches.find((file) => file.newFileName === change.path || file.oldFileName === change.path);
    if (!patch?.hunks.length) return [{ type: 'content', content: { type: 'text', text: `${change.operation}: ${change.path}` } }];
    const old: string[] = [];
    const next: string[] = [];
    for (const hunk of patch.hunks) for (const line of hunk.lines) {
      if (line[0] === ' ' || line[0] === '-') old.push(line.slice(1));
      if (line[0] === ' ' || line[0] === '+') next.push(line.slice(1));
    }
    return [{ type: 'diff', path: String(change.path), oldText: change.operation === 'add' ? null : old.join('\n'), newText: next.join('\n') }];
  });
}
