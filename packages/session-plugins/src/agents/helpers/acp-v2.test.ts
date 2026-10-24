import { PassThrough, Writable } from 'node:stream';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { describe, expect, it, vi } from 'vitest';

import { nodeReadableToWeb } from './acp-stdio';
import { connectStdioAcpV2 } from './acp-v2';

/**
 * A v2 agent in this process, on the other end of the transport's stdio. `prompt` serves
 * `session/prompt`; `agent()` is the agent's context, which sends the session's updates.
 */
function agentPair(opts: {
  protocolVersion?: number;
  prompt?: (params: v2.PromptRequest) => Promise<v2.PromptResponse>;
} = {}) {
  const toAgent = new PassThrough();
  const configRequests: v2.SetSessionConfigOptionRequest[] = [];
  const toClient = new PassThrough();
  let context!: v2.AgentContext;
  v2.agent({ name: 'test-agent' })
    .onConnect((connection) => {
      context = connection.client;
    })
    .onRequest(v2.methods.agent.initialize, async () => ({
      protocolVersion: (opts.protocolVersion ?? 2) as 2,
      info: { name: 'test-agent', version: '1' },
      capabilities: { session: { prompt: { image: {} }, fork: {} } },
      authMethods: [
        { type: 'terminal', methodId: 'login', name: 'Log in', args: ['login'], env: [{ name: 'A', value: '1' }] },
      ],
      _meta: { steering: { supported: true } },
    }))
    .onRequest(v2.methods.agent.session.new, async () => ({
      sessionId: 's1',
      configOptions: [
        {
          configId: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'a',
          options: [{ groupId: 'g', name: 'Group', options: [{ value: 'a', name: 'A' }] }],
        },
      ],
      availableCommands: [{ name: 'review', description: 'Review', input: { type: 'text', hint: '<pr>' } }],
    }))
    .onRequest(v2.methods.agent.session.prompt, async ({ params }) => opts.prompt!(params))
    .onRequest(v2.methods.agent.session.setConfigOption, async ({ params }) => {
      configRequests.push(params);
      return { configOptions: [] };
    })
    .connect(v2.ndJsonStream(Writable.toWeb(toClient) as WritableStream<Uint8Array>, nodeReadableToWeb(toAgent)));
  const updates: SessionNotification[] = [];
  const permissions: unknown[] = [];
  const api = connectStdioAcpV2({ stdin: toAgent, stdout: toClient }, () => ({
    sessionEvent: () => {},
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    requestPermission: async (request: unknown) => {
      permissions.push(request);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
  }));
  const send = (u: unknown) =>
    context.notify(v2.methods.client.session.update, { sessionId: 's1', update: u as v2.SessionUpdate });
  const kinds = () => updates.map(({ update }) => update.sessionUpdate as string);
  return { api, updates, permissions, configRequests, kinds, send, agent: () => context };
}

const initialize = (api: ReturnType<typeof agentPair>['api']) =>
  api.initialize({ protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('connectStdioAcpV2', () => {
  it('reads a v2 initialize as the host reads v1: capabilities, auth methods, and the protocol it speaks', async () => {
    const { api } = agentPair();
    const response = await initialize(api);
    expect(response.protocolVersion).toBe(2);
    expect(response.agentCapabilities).toMatchObject({
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { fork: {}, close: {} },
    });
    expect(response._meta).toEqual({ steering: { supported: true } });
    expect(response.authMethods).toEqual([
      { type: 'terminal', id: 'login', name: 'Log in', args: ['login'], env: { A: '1' } },
    ]);
  });

  it('fails loudly when the agent answers another protocol version', async () => {
    const { api } = agentPair({ protocolVersion: 1 });
    await expect(initialize(api)).rejects.toThrow(/v2 API only supports/);
  });

  it('gives a new session v1 config options, and its commands as an update after the response', async () => {
    const { api, updates } = agentPair();
    await initialize(api);
    const session = await api.newSession({ cwd: '/w', mcpServers: [] });
    expect(session.configOptions).toEqual([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'a',
        options: [{ group: 'g', name: 'Group', options: [{ value: 'a', name: 'A' }] }],
      },
    ]);
    expect(updates).toEqual([]);
    await settle();
    expect(updates).toEqual([
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review', description: 'Review', input: { hint: '<pr>' } }],
        },
      },
    ]);
  });

  it('sets a config option with the v2 tag of its value, which the agent validates', async () => {
    const pair = agentPair();
    await initialize(pair.api);
    await pair.api.setSessionConfigOption!({ sessionId: 's1', configId: 'mode', value: 'bypassPermissions' });
    await pair.api.setSessionConfigOption!({ sessionId: 's1', configId: 'fast', type: 'boolean', value: true } as never);
    expect(pair.configRequests).toEqual([
      { sessionId: 's1', configId: 'mode', type: 'id', value: 'bypassPermissions' },
      { sessionId: 's1', configId: 'fast', type: 'boolean', value: true },
    ]);
  });

  it('returns the native message receipt before foreground idle and forwards the echo', async () => {
    const pair = agentPair({ prompt: async () => ({ messageId: 'u', _meta: { receipt: true } }) });
    await initialize(pair.api);
    await expect(pair.api.prompt({ sessionId: 's1', prompt: [] }, { requestId: 'r', message: { kind: 'message', role: 'user', messageId: 'local', text: 'hi' } })).resolves.toEqual({ status: 'accepted', requestId: 'r', messageId: 'u', _meta: { receipt: true } });
    expect(pair.updates).toEqual([]);
    await pair.send({ sessionUpdate: 'user_message', messageId: 'u', content: [{ type: 'text', text: 'hi' }] });
    await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_tokens', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    await vi.waitFor(() => expect(pair.updates).toHaveLength(2));
    expect(decodeSessionUpdate(pair.updates[0].update)).toMatchObject({ kind: 'message', role: 'user', messageId: 'u', text: 'hi' });
    expect(decodeSessionUpdate(pair.updates[1].update)).toMatchObject({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'max_tokens', usage: { totalTokens: 5 } });
  });

  it('does not reinterpret idle errors or cancellation as prompt responses', async () => {
    const receipt = Promise.withResolvers<v2.PromptResponse>();
    const entered = Promise.withResolvers<void>();
    const pair = agentPair({ prompt: async () => { entered.resolve(); return receipt.promise; } });
    await initialize(pair.api);
    const response = pair.api.prompt({ sessionId: 's1', prompt: [] });
    await entered.promise;
    await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'error', error: { code: -32000, message: 'Authentication required' } });
    await vi.waitFor(() => expect(pair.updates).toHaveLength(1));
    expect(decodeSessionUpdate(pair.updates[0].update)).toMatchObject({ kind: 'agent_state', error: { code: -32000 } });
    receipt.resolve({ messageId: 'u' });
    await expect(response).resolves.toMatchObject({ status: 'accepted', messageId: 'u' });
  });

  it('preserves the rejection of a prompt cancelled before acceptance', async () => {
    const pair = agentPair({ prompt: async () => { throw new v2.RequestError(-32800, 'Request cancelled'); } });
    await initialize(pair.api);
    await expect(pair.api.prompt({ sessionId: 's1', prompt: [] })).rejects.toMatchObject({ code: -32800 });
  });

  it('preserves terminal bytes and references without projecting tool text', async () => {
    const pair = agentPair();
    await initialize(pair.api);
    const updates: v2.SessionUpdate[] = [
      { sessionUpdate: 'terminal_update', terminalId: 't1', command: 'ls' },
      { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: '8J8=' },
      { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: 'mYI=' },
      { sessionUpdate: 'terminal_update', terminalId: 't1', exitStatus: { exitCode: 0 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', content: [{ type: 'terminal', terminalId: 't1' }] },
    ];
    for (const update of updates) await pair.send(update);
    await settle();
    expect(pair.updates.map(({ update }) => update)).toEqual(updates);
  });

  it('preserves a v2 diff block and every raw patch byte', async () => {
    const pair = agentPair();
    await initialize(pair.api);
    await pair.send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      content: [
        {
          type: 'diff',
          changes: [{ operation: 'modify', path: '/w/a.txt', fileType: 'text' }],
          patch: {
            format: 'git_patch',
            text: 'diff --git a/w/a.txt b/w/a.txt\n--- a/w/a.txt\n+++ b/w/a.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
          },
        },
      ],
    });
    await settle();
    expect(pair.updates[0]!.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/w/a.txt', fileType: 'text' }], patch: { format: 'git_patch', text: 'diff --git a/w/a.txt b/w/a.txt\n--- a/w/a.txt\n+++ b/w/a.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n' } }],
    });
  });

  it('preserves the standard tool name and a permission request with its own title', async () => {
    const pair = agentPair();
    await initialize(pair.api);
    await pair.send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'plan-1',
      name: 'ExitPlanMode',
      title: 'Ready to code?',
      rawInput: { plan: '1. write the file' },
      _meta: { claudeCode: { parentToolUseId: null } },
    });
    await pair.agent().request(v2.methods.client.session.requestPermission, {
      sessionId: 's1',
      title: 'Approve implementation?',
      subject: { type: 'tool_call', toolCall: { toolCallId: 'plan-1', name: 'ExitPlanMode' } },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    await settle();
    expect(pair.updates[0]!.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'plan-1',
      name: 'ExitPlanMode',
      title: 'Ready to code?',
      rawInput: { plan: '1. write the file' },
      _meta: { claudeCode: { parentToolUseId: null } },
    });
    expect(pair.permissions).toEqual([
      {
        sessionId: 's1',
        title: 'Approve implementation?',
        subject: { type: 'tool_call', toolCall: { toolCallId: 'plan-1', name: 'ExitPlanMode' } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    ]);
  });

  it.each([
    { type: 'tool_call', toolCall: { toolCallId: 'tool-1', title: 'Tool title', kind: 'execute' } },
    { type: 'command', command: 'ls -la', cwd: '/work', toolCallId: 'tool-1', terminalId: 'term-1', _meta: { vendor: { extra: true } } },
    null,
    undefined,
  ])('preserves the complete permission subject %j without manufacturing a tool call', async (subject) => {
    const pair = agentPair();
    await initialize(pair.api);
    const request = {
      sessionId: 's1', title: 'Run command?', description: 'Approval details',
      ...(subject === undefined ? {} : { subject }),
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      _meta: { vendor: { context: 1 } },
    };
    const response = await pair.agent().request(v2.methods.client.session.requestPermission, request as v2.RequestPermissionRequest);
    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(pair.permissions).toEqual([request]);
    expect(pair.permissions[0]).not.toHaveProperty('toolCall');
  });
});
