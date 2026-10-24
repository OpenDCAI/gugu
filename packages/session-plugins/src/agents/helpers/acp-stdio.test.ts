import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { connectStdioAcp, nodeReadableToWeb } from './acp-stdio';
import type { NormalizedEvent } from '@gugu/session-core/acp';

it('v1 stdio returns a dispatch receipt and keeps activity until the real RPC response', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events: NormalizedEvent[] = [];
  const requests: { id: number; method: string; params: Record<string, unknown> }[] = [];
  let buffered = '';
  stdin.on('data', bytes => {
    buffered += bytes.toString();
    const lines = buffered.split('\n'); buffered = lines.pop()!;
    for (const line of lines) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
    }
  });
  const api = connectStdioAcp({ stdin, stdout }, () => ({
    sessionEvent: ({ event }) => events.push(event), sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }));
  await api.initialize({ protocolVersion: 1 });
  expect(requests[0].params).toMatchObject({ clientCapabilities: { _meta: { jetbrains: {
    air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] },
  } } } });
  const receipt = await api.prompt({ sessionId: 's', prompt: [{ type: 'text', text: 'hi' }] });
  expect(receipt.status).toBe('dispatched');
  expect(events).toEqual([{ kind: 'agent_state', source: 'request', state: 'running' }]);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  stdout.write(JSON.stringify({ jsonrpc: '2.0', id: requests[1].id, result: { stopReason: 'end_turn' } }) + '\n');
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ source: 'request', state: 'idle', stopReason: 'end_turn' }));
  stdout.end(); stdin.end();
});

it('decodes permission tool facts before they cross the v1 transport boundary', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const permissions: unknown[] = [];
  let buffered = '';
  stdin.on('data', bytes => {
    buffered += bytes.toString();
    const lines = buffered.split('\n'); buffered = lines.pop()!;
    for (const line of lines) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
    }
  });
  const api = connectStdioAcp({ stdin, stdout }, () => ({
    sessionEvent: () => {},
    requestPermission: async request => { permissions.push(request); return { outcome: { outcome: 'selected', optionId: 'allow' } }; },
  }));
  await api.initialize({ protocolVersion: 1 });
  const tool = { toolCallId: 'read', title: 'Read file', kind: 'read', rawInput: { path: '/work/a' },
    content: [{ type: 'content', content: { type: 'text', text: 'Approval body' } }], _meta: { toolName: 'Read' } };
  stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: {
    sessionId: 's', toolCall: tool, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  } }) + '\n');
  await vi.waitFor(() => expect(permissions).toHaveLength(1));
  expect(permissions[0]).toMatchObject({ subject: { type: 'tool_call', toolCall: tool },
    toolCall: { kind: 'tool_update', toolCallId: 'read', toolName: 'Read', toolKind: 'read',
      rawInput: JSON.stringify({ path: '/work/a' }, null, 2), outputText: 'Approval body' } });
  stdout.end(); stdin.end();
});

describe('nodeReadableToWeb', () => {
  it('drives delayed Node stdout without relying on Readable.toWeb flowing mode', async () => {
    const source = new PassThrough();
    const toWeb = vi.spyOn(Readable, 'toWeb').mockImplementation(() => {
      throw new Error('Readable.toWeb must not own ACP stdout flow');
    });
    const reader = nodeReadableToWeb(source).getReader();

    const first = reader.read();
    source.write('{"id":1}\n');

    await expect(first).resolves.toEqual({
      done: false,
      value: Uint8Array.from(Buffer.from('{"id":1}\n')),
    });
    source.end();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(toWeb).not.toHaveBeenCalled();
  });

  it('propagates child stdout errors to the web reader', async () => {
    const source = new PassThrough();
    const reader = nodeReadableToWeb(source).getReader();
    const failure = new Error('adapter stdout failed');

    source.destroy(failure);

    await expect(reader.read()).rejects.toThrow('adapter stdout failed');
  });
});
