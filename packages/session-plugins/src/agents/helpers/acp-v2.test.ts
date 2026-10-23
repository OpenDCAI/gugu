import { PassThrough, Writable } from 'node:stream';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { AcpTranscriptParser, decodeSessionUpdate } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';

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
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
    requestPermission: async (request: unknown) => {
      permissions.push(request);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
  }) as unknown as Client);
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
    expect(api.protocolVersion).toBe(2);
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

  it('ends a prompt at the idle after the agent took it in, once the client has that idle', async () => {
    const taken = Promise.withResolvers<void>();
    const pair = agentPair({
      prompt: async () => {
        // The idle of earlier work (a cycle the agent ran on its own) is not this prompt's.
        await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
        await pair.send({ sessionUpdate: 'user_message', messageId: 'm1', content: [{ type: 'text', text: 'hi' }] });
        await pair.send({ sessionUpdate: 'state_update', state: 'running' });
        taken.resolve();
        return { messageId: 'm1' };
      },
    });
    await initialize(pair.api);
    let settled = false;
    const outcome = pair.api.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] }).finally(() => {
      settled = true;
    });
    await taken.promise;
    await settle();
    expect(settled).toBe(false);

    await pair.send({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'max_tokens',
      usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 },
    });
    await expect(outcome).resolves.toEqual({
      stopReason: 'max_tokens',
      usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 },
    });
    // The receipt still belongs to the prompt adapter; the cell inserts the local input.
    expect(pair.kinds()).toEqual(['state_update', 'state_update', 'state_update']);
  });

  it('forwards whole-message replacements and chunks to the domain decoder without ending the prompt', async () => {
    const taken = Promise.withResolvers<void>();
    const pair = agentPair({
      prompt: async () => {
        await pair.send({ sessionUpdate: 'user_message', messageId: 'u1', content: [] });
        taken.resolve();
        return { messageId: 'u1' };
      },
    });
    await initialize(pair.api);
    const outcome = pair.api.prompt({ sessionId: 's1', prompt: [] });
    await taken.promise;
    await pair.send({ sessionUpdate: 'agent_message', messageId: 'a1', content: [{ type: 'text', text: 'one' }] });
    await pair.send({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: ' two' } });
    await pair.send({ sessionUpdate: 'agent_message', messageId: 'a1', _meta: { x: 1 } });
    await pair.send({ sessionUpdate: 'agent_message', messageId: 'a1', content: [{ type: 'text', text: 'short' }] });
    await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    await expect(outcome).resolves.toEqual({ stopReason: 'end_turn' });
    expect(pair.kinds()).toEqual(['agent_message', 'agent_message_chunk', 'agent_message', 'agent_message', 'state_update']);
    const parser = new AcpTranscriptParser({ sessionId: 's1' });
    for (const [index, { update }] of pair.updates.entries()) parser.pushEvent(decodeSessionUpdate(update), index);
    const items = [...parser.history.flatMap(turn => turn.items), ...(parser.activeTurn?.items ?? [])];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', text: 'short', _meta: { x: 1 } });
  });

  it('ends a prompt that the agent took in while an earlier one ran with that work, and waits for a later one', async () => {
    let n = 0;
    const pair = agentPair({
      prompt: async () => {
        n += 1;
        if (n <= 2) await pair.send({ sessionUpdate: 'user_message', messageId: `m${n}`, content: [] });
        return { messageId: `m${n}` };
      },
    });
    await initialize(pair.api);
    const first = pair.api.prompt({ sessionId: 's1', prompt: [] });
    const second = pair.api.prompt({ sessionId: 's1', prompt: [] });
    const third = pair.api.prompt({ sessionId: 's1', prompt: [] });
    await settle();
    await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' });
    let thirdEnded = false;
    void third.then(() => (thirdEnded = true));
    await settle();
    expect(thirdEnded).toBe(false);
    await pair.send({ sessionUpdate: 'user_message', messageId: 'm3', content: [] });
    await pair.send({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
    await expect(third).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('fails a prompt whose turn ends with an error with the JSON-RPC error of that idle', async () => {
    const pair = agentPair({
      prompt: async () => {
        await pair.send({ sessionUpdate: 'user_message', messageId: 'm1', content: [] });
        setTimeout(() => {
          void pair.send({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'error',
            error: { code: -32000, message: 'Authentication required' },
          });
        }, 0);
        return { messageId: 'm1' };
      },
    });
    await initialize(pair.api);
    await expect(pair.api.prompt({ sessionId: 's1', prompt: [] })).rejects.toEqual({
      code: -32000,
      message: 'Authentication required',
    });
  });

  it('reads a queued prompt that a cancel ended before the agent took it in as a cancelled turn', async () => {
    const pair = agentPair({
      prompt: async () => {
        throw new v2.RequestError(-32800, 'Request cancelled');
      },
    });
    await initialize(pair.api);
    await expect(pair.api.prompt({ sessionId: 's1', prompt: [] })).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('reports a display terminal as the text output of the tool call that shows it, with its exit', async () => {
    const pair = agentPair();
    await initialize(pair.api);
    await pair.send({ sessionUpdate: 'terminal_update', terminalId: 't1', command: 'ls' });
    await pair.send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      title: 'ls',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 't1' }],
    });
    await pair.send({ sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: Buffer.from('a\n').toString('base64') });
    await pair.send({
      sessionUpdate: 'terminal_update',
      terminalId: 't1',
      output: { data: Buffer.from('a\nb\n').toString('base64') },
      exitStatus: { exitCode: 0 },
    });
    await settle();
    expect(pair.updates.map(({ update }) => update)).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'ls', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        content: [{ type: 'content', content: { type: 'text', text: 'a\n' } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        content: [{ type: 'content', content: { type: 'text', text: 'a\nb\n' } }],
        _meta: { terminal_exit: { exit_code: 0, signal: null } },
      },
    ]);
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
