import { expect, it } from 'vitest';
import { TERMINAL_CHUNK_CAPABILITY } from '@gugu/session-core/acp/client';
import type { WireMessage } from '@gugu/session-wire';
import { machineIdCodec } from '../machine-routing';
import { createSessionHostClient, type SessionHostPipeOpener } from '../../../shared/lib/ipc/session-host-client';
import { decodeHostWsMessage, encodeHostWsMessage } from '../../../shared/lib/ipc/host-ws-protocol';
import { createPieceJoiner, toPieces } from '../../../shared/lib/ipc/session-host-device-frames';

it('preserves optional ACP capabilities through machine naming, taskhost RPC and device-link pieces', async () => {
  const received: unknown[] = [];
  const open: SessionHostPipeOpener = async handlers => ({
    close() {},
    send(frame) {
      const join = createPieceJoiner(joined => {
        const message = decodeHostWsMessage(joined);
        if (message?.t === 'invoke') queueMicrotask(() => {
          handlers.onFrame(encodeHostWsMessage({ t: 'port', channel: 'acp-wire:port', port: 7 }));
          handlers.onFrame(encodeHostWsMessage({ t: 'result', id: message.id, ok: true, value: null }));
        });
        if (message?.t === 'pm') {
          received.push(message.msg);
          handlers.onFrame(encodeHostWsMessage(message));
        }
      });
      for (const batch of toPieces([frame])) join(batch);
    },
  });
  const host = createSessionHostClient(open);
  try {
    const transport = await host.openWireTransport('acp-wire');
    const codec = machineIdCodec('remote-device', ['00000000-0000-4000-8000-000000000001']);
    const echoed: unknown[] = [];
    transport.onMessage(message => echoed.push(codec.inbound(message)));
    for (const kind of ['snapshot', 'attach'] as const) {
      const message: WireMessage = { kind, id: kind, topic: 'session.terminals|{"sessionId":"s"}', capabilities: [TERMINAL_CHUNK_CAPABILITY] };
      transport.post(codec.outbound(message));
      expect(received.at(-1)).toEqual(message);
      expect(echoed.at(-1)).toEqual(message);
    }
    transport.close?.();
  } finally {
    host.close();
  }
});
