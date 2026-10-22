import { PassThrough, Readable, Writable } from 'node:stream';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk-v2/experimental/v2/unstable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { connectStdioAcp } from './acp-stdio';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

function rig(app = v2.agent()) {
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  const updates: SessionNotification[] = [];
  const permission = vi.fn().mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow' } });
  const server = app
    .onRequest(v2.methods.agent.initialize, () => ({ protocolVersion: 2, info: { name: 'any-harness', version: '1' }, capabilities: { session: { prompt: { image: {} }, fork: {} } }, _meta: { steering: { supported: true } } }))
    .onRequest(v2.methods.agent.session.new, () => ({ sessionId: 'root', configOptions: [] }))
    .connect(v2.ndJsonStream(Writable.toWeb(incoming) as WritableStream<Uint8Array>, Readable.toWeb(outgoing) as ReadableStream<Uint8Array>));
  const api = connectStdioAcp({ stdin: outgoing, stdout: incoming }, () => ({
    sessionUpdate: async (params) => { updates.push(params); }, requestPermission: permission,
  } as Client), 2);
  cleanup.push(() => { server.close(); incoming.destroy(); outgoing.destroy(); });
  const initialize = () => api.initialize({ protocolVersion: 2, clientInfo: { name: 'test', version: '1' }, clientCapabilities: {} });
  return { api, server, updates, permission, initialize };
}

describe('shared ACP v2 protocol boundary', () => {
  it('negotiates v2 for any harness and preserves admission without inventing a stop reason', async () => {
    const app = v2.agent().onRequest(v2.methods.agent.session.prompt, async ({ params, client }) => {
      await client.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'user_message', messageId: 'native-user', content: params.prompt } });
      await client.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'state_update', state: 'running' } });
      return { messageId: 'native-user' };
    });
    const { api, server, updates, initialize } = rig(app);
    expect(await initialize()).toMatchObject({ protocolVersion: 2, agentInfo: { name: 'any-harness' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
    await api.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(await api.prompt({ sessionId: 'root', prompt: [{ type: 'text', text: 'hello' }] })).toEqual({ messageId: 'native-user' });
    expect(updates.map(({ update }) => decodeSessionUpdate(update))).toEqual([{ kind: 'agent_state', state: 'running' }]);
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'max_tokens', usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 } } });
    await vi.waitFor(() => expect(updates.at(-1)?.update).toMatchObject({ state: 'idle', stopReason: 'max_tokens' }));
    expect(decodeSessionUpdate(updates.at(-1)!.update)).toMatchObject({ kind: 'agent_state', state: 'idle', stopReason: 'max_tokens', usage: { totalTokens: 3 } });
  });

  it('routes child permissions after parent idle and retains the child cancel capability in later state snapshots', async () => {
    const { server, updates, permission, initialize } = rig();
    await initialize();
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'subagent_update', sessionId: 'child', title: 'worker', capabilities: { cancel: {} }, state: { state: 'running' } } });
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
    const result = await server.client.request(v2.methods.client.session.requestPermission, { sessionId: 'child', title: 'Run a command', subject: { type: 'tool_call', toolCall: { toolCallId: 'child-tool', name: 'Bash', rawInput: { command: 'echo allowed' } } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(permission).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child', toolCall: expect.objectContaining({ toolCallId: 'child-tool', title: 'Run a command' }) }));
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'requires_action' } } });
    await vi.waitFor(() => expect(decodeSessionUpdate(updates.at(-1)!.update)).toMatchObject({ kind: 'subagent_update', canCancel: true }));
    expect(updates.filter(({ sessionId, update }) => sessionId === 'root' && (update as { sessionUpdate: string; state?: string }).sessionUpdate === 'state_update' && (update as { state?: string }).state === 'running')).toHaveLength(0);
  });

  it('serves steering and independent background stop through named extensions', async () => {
    const steering = vi.fn().mockReturnValue({ outcome: 'injected' });
    const stop = vi.fn().mockReturnValue({ stopped: true });
    const app = v2.agent()
      .onRequest('_session/steering', { parse: (value) => value as Record<string, unknown> }, ({ params }) => steering(params))
      .onRequest('_session/async_task/stop', { parse: (value) => value as Record<string, unknown> }, ({ params }) => stop(params));
    const { api, server, updates, initialize } = rig(app);
    await initialize();
    const request = { sessionId: 'root', prompt: [{ type: 'text', text: 'join this turn' }], _meta: { steering: { idleBehavior: 'promptRequired', delivery: 'next' } } };
    expect(await api.extMethod!('_session/steering', request)).toEqual({ outcome: 'injected' });
    expect(steering).toHaveBeenCalledWith(request);
    expect(await api.extMethod!('_session/async_task/stop', { sessionId: 'root', asyncTaskId: 'task-2' })).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledWith({ sessionId: 'root', asyncTaskId: 'task-2' });
    await server.client.notify('_session/async_task/update', { sessionId: 'root', update: { sessionUpdate: 'async_task_state_update', asyncTaskId: 'task-2', state: 'stopped' } });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(decodeSessionUpdate(updates[0].update)).toMatchObject({ kind: 'async_task_state', asyncTaskId: 'task-2', state: 'stopped' });
  });

  it('keeps tool identity across metadata patches and decodes terminal bytes across UTF-8 chunk boundaries', async () => {
    const { server, updates, initialize } = rig();
    await initialize();
    const send = (update: v2.SessionUpdate) => server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'command', name: 'Bash', title: 'Run', status: 'in_progress', _meta: { vendor: { parent: 'delegate' }, removed: true }, content: [{ type: 'terminal', terminalId: 'terminal' }] });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'command', _meta: { removed: null, added: 1 } });
    const bytes = Buffer.from('你');
    await send({ sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal', data: bytes.subarray(0, 1).toString('base64') });
    await send({ sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal', data: bytes.subarray(1).toString('base64') });
    await send({ sessionUpdate: 'terminal_update', terminalId: 'terminal', exitStatus: { exitCode: 0 } });
    await vi.waitFor(() => expect(updates.at(-1)?.update).toMatchObject({ toolCallId: 'command', rawOutput: '你', _meta: { terminal_exit: { exit_code: 0 } } }));
    const patched = updates.find(({ update }) => update._meta?.added === 1)?.update;
    expect(patched?._meta).toEqual({ toolName: 'Bash', vendor: { parent: 'delegate' }, added: 1, entitySnapshot: true });
    expect(decodeSessionUpdate(updates[0].update)).toMatchObject({ kind: 'tool_call', toolName: 'Bash', terminalId: 'terminal' });
  });

  it('materializes v2 patches for edit approvals and clears removed tool content', async () => {
    const { server, updates, initialize } = rig();
    await initialize();
    const send = (update: v2.SessionUpdate) => server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', name: 'Edit', content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/workspace/file.txt' }], patch: { format: 'git_patch', text: 'diff --git /workspace/file.txt /workspace/file.txt\n--- /workspace/file.txt\n+++ /workspace/file.txt\n@@ -1,2 +1,2 @@\n unchanged\n-before\n+after\n' } }] });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(decodeSessionUpdate(updates[0].update)).toMatchObject({ kind: 'tool_call', diffs: [{ path: '/workspace/file.txt', oldText: 'unchanged\nbefore', newText: 'unchanged\nafter' }], replace: true });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: null });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(decodeSessionUpdate(updates[1].update)).toMatchObject({ kind: 'tool_call', diffs: [], replace: true });
  });

  it('preserves authoritative full-message replacements, including clearing a replayed entity', async () => {
    const { server, updates, initialize } = rig();
    await initialize();
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'agent_message', messageId: 'message', content: [{ type: 'text', text: 'replacement' }] } });
    await server.client.notify(v2.methods.client.session.update, { sessionId: 'root', update: { sessionUpdate: 'agent_message', messageId: 'message', content: null } });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates.map(({ update }) => decodeSessionUpdate(update))).toEqual([
      { kind: 'message', role: 'assistant', messageId: 'message', text: 'replacement', replace: true },
      { kind: 'message', role: 'assistant', messageId: 'message', text: '', replace: true },
    ]);
  });
});
