import { APP_FRAME_MARKER, SYNC_PORT_REQUEST, SYNC_PORT_WINDOW_MESSAGE, type FrameToHost, type HostToFrame } from '@shared/extensions/app-runtime-protocol';
import { backgroundWire, BACKGROUND_HOST_EVENT } from '@shared/extensions/background-wire';
import { messageHost } from './framed-host';

declare global {
  interface Window {
    /** Only installed by the server's isolated background browser context. */
    __guguBackgroundPost?: (message: unknown) => Promise<void>;
  }
}

/** A server background uses the page runtime and message protocol, with the background's members. */
export function backgroundHost() {
  const post = window.__guguBackgroundPost!;
  let sync: MessagePort | null = null;
  const send = (frame: FrameToHost) => { void post(backgroundWire(frame, true)); };
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data !== SYNC_PORT_REQUEST || sync) return;
    const channel = new MessageChannel();
    sync = channel.port1;
    sync.onmessage = ({ data }) => send({ m: APP_FRAME_MARKER, t: 'sync', data });
    window.postMessage(SYNC_PORT_WINDOW_MESSAGE, '*', [channel.port2]);
  });
  return messageHost({
    post: send,
    listen(handler) {
      window.addEventListener(BACKGROUND_HOST_EVENT, (event) => {
        const frame = backgroundWire((event as CustomEvent).detail, false) as HostToFrame;
        if (frame.t === 'sync') sync?.postMessage(frame.data);
        else handler(frame);
      });
    },
  }, { background: true });
}
