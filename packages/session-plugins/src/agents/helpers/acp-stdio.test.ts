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
