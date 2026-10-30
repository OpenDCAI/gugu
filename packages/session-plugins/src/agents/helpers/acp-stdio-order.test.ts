import { PassThrough } from 'node:stream';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AcpTranscriptParser, decodeSessionUpdate, type NormalizedEvent } from '@gugu/session-core/acp';
import { expect, it, vi } from 'vitest';
import { connectStdioAcp } from './acp-stdio';

it('keeps a tool and its negotiated async-task announcement in the same stdout chunk in wire order', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const events: NormalizedEvent[] = [], parser = new AcpTranscriptParser({ sessionId: 's' });
  const receive = (event: NormalizedEvent) => { events.push(event); parser.pushEvent(event); };
  let pending = '';
  stdin.on('data', bytes => {
    pending += bytes.toString();
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
    }
  });
  const api = connectStdioAcp({ stdin, stdout }, () => ({
    sessionEvent: ({ event }: { event: NormalizedEvent }) => receive(event),
    // The same fixture also runs against the parent, whose wire ingress is in this callback.
    sessionUpdate: (params: SessionNotification) => receive(decodeSessionUpdate(params.update)),
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  }));
  await api.initialize({ protocolVersion: 1 });
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'X', title: 'Local command', kind: 'execute', status: 'completed' },
    { sessionUpdate: 'async_task_spawned', asyncTaskId: 'T', toolCallId: 'X', name: 'Local command',
      taskType: 'command', showInTranscript: true, canStop: true },
  ];
  stdout.write(updates.map(update => JSON.stringify({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's', update } })).join('\n') + '\n');
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events.map(event => event.kind)).toEqual(['tool_call', 'async_task']);
  expect(parser.activeTurn?.items).toMatchObject([{ kind: 'execute-tool-call', toolCallId: 'X', backgroundTaskId: 'T' }]);
  stdout.end(); stdin.end();
});
