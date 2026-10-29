import { APP_FRAME_MARKER, type FrameToHost } from '@shared/extensions/app-runtime-protocol';
import { createGugu } from './create-gugu';
import * as files from './files-entry';
import { messageHost } from './framed-host';
import { programCall } from './program-call';
import { setSyncPortSource, type SyncPortLike } from './sync-link';

/** A program's channel to main: the child's IPC (`process.send` / `process.on('message')`). */
export type ProgramChannel = {
  send?: (message: unknown) => boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  channel?: { unref(): void };
};

/**
 * `gugu` for an App's MCP program (F16) over its channel to main — requests and answers as a phone's iframe
 * does (`messageHost`), and the file sync traffic on the same channel as `{ t: 'sync' }`: main relays it
 * exactly as it relays a page's port. A program's open files publish no presence (`program: true`).
 * Each request says which tool call it was made in (`call`, from `programCall`): main answers it as that call's agent.
 */
export function startProgramGugu(channel: ProgramChannel): Readonly<Record<string, unknown>> {
  const send = channel.send?.bind(channel);
  if (!send) throw new Error('gugu: this program was not started by gugu (it has no host channel)');
  const syncPort: SyncPortLike = {
    postMessage: (data) => send({ m: APP_FRAME_MARKER, t: 'sync', data } satisfies FrameToHost),
    onmessage: null,
  };
  const host = messageHost(
    {
      post: (message) => {
        const callId = message.t === 'call' ? programCall.getStore() : undefined;
        send(callId === undefined ? message : { ...message, call: callId });
      },
      listen: (handler) => {
        channel.on('message', (message) => {
          const frame = message as { m?: unknown; t?: unknown; data?: unknown } | null;
          if (frame?.m === APP_FRAME_MARKER && frame.t === 'sync') {
            syncPort.onmessage?.({ data: frame.data });
            return;
          }
          // A host-owned projection callback can arrive while a different tool
          // call is running. It never inherits that call's agent authority.
          const event = message as { t?: string; event?: { type?: string } } | null;
          if (frame?.m === APP_FRAME_MARKER && event?.t === 'event' && event.event?.type === 'projectionSource') programCall.exit(() => handler(message));
          else handler(message);
        });
        // Listening does not keep the program alive: it lives as long as its own work does (its MCP server reading stdin).
        // A program that failed and stopped working exits instead of hanging until gugu's initialize times out.
        channel.channel?.unref();
      },
    },
    { program: true },
  );
  setSyncPortSource(() => Promise.resolve(syncPort));
  return createGugu(host, { files: () => Promise.resolve(files) });
}
