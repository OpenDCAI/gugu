import { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  APP_FRAME_MARKER,
  FRAME_TYPE,
  SYNC_PORT_REQUEST,
  SYNC_PORT_WINDOW_MESSAGE,
  readFrameHead,
  readFrameUpdate,
  splitRoutingKey,
  type SyncToMain,
  type SyncToPage,
} from '@shared/extensions/app-runtime-protocol';

/**
 * This page's end of the sync port, and the socket the Hocuspocus provider thinks it has.
 *
 * The real WebSocket lives in main, which holds the credential and shares one connection
 * among every page on the machine (`L3-runtime-interface.md` §3). What the page gets is a
 * MessagePort carrying the same frames; `PortSocket` dresses it up as a WebSocket so the
 * stock provider runs unmodified — its reconnect and resync are what keep the replica
 * honest, and a second implementation of them is exactly what the prototype showed going
 * wrong.
 */

type ControlHandler = (message: Exclude<SyncToPage, { t: 'up' } | { t: 'down' }>) => void;

/** One looker at a file's incoming updates (`SyncLink.inspect`). */
interface Inspector {
  see(update: Uint8Array): void;
  failed(error: unknown): void;
}

/** A hold never outlives this, whatever the holder forgets to do. */
const MAX_HOLD_MS = 5_000;
/**
 * What a hold keeps back: frames that change the replica or make the editor dispatch (Sync, and
 * Awareness — remote cursors are a dispatch too). Auth answers, SyncStatus, Stateless and Close
 * pass: holding them only stalls this page's own sending (L1: a held Auth answer after a
 * reconnect kept local edits back 10 s).
 */
const HELD_FRAME_TYPES: ReadonlySet<number> = new Set([FRAME_TYPE.Sync, FRAME_TYPE.Awareness]);

/** This runtime's end of the sync port: a MessagePort in a page, the IPC channel in a program (F16). */
export interface SyncPortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
}

/**
 * The page's port: posted by the preload into this very window (desktop), or by the outer gugu page to its
 * App's iframe (phone). Anything else claiming the marker (a page script, a frame of its own) could only hand
 * the runtime a port it controls itself. Asked for once something listens: the host holds the port until
 * asked (摩擦单 F28 — posted before a listener existed, it was lost and `files.open(…)` never settled).
 */
function windowPort(): Promise<SyncPortLike> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const fromHost = event.source === window || (window.parent !== window && event.source === window.parent);
      if (!fromHost || event.data !== SYNC_PORT_WINDOW_MESSAGE) return;
      const port = event.ports[0];
      if (!port) return;
      window.removeEventListener('message', onMessage);
      resolve(port as unknown as SyncPortLike);
    };
    window.addEventListener('message', onMessage);
    if (window.parent !== window) window.parent.postMessage({ m: APP_FRAME_MARKER, t: 'sync-port' }, '*');
    else window.postMessage(SYNC_PORT_REQUEST, '*');
  });
}

let portSource: () => Promise<SyncPortLike> = windowPort;

/** Where this runtime's sync port comes from — set by a runtime that is not a page (a program, F16) before any open. */
export function setSyncPortSource(source: () => Promise<SyncPortLike>): void {
  portSource = source;
}

class SyncLink {
  private port: SyncPortLike | null = null;
  private portArrived: Promise<SyncPortLike> | null = null;
  /** Last word from main about the machine's connection. */
  private up = false;
  private socket: PortSocket | null = null;
  private readonly controlHandlers = new Set<ControlHandler>();
  /** open file → frames from the service held back from its replica (see `hold`). */
  private readonly holds = new Map<string, { depth: number; frames: ArrayBuffer[] }>();
  /** open file → what looks at each incoming update while nothing is held, and may start a hold (see `inspect`). */
  private readonly inspectors = new Map<string, Set<Inspector>>();
  /** open file → told when its last hold ends (see `onReleased`). */
  private readonly releaseHandlers = new Map<string, Set<() => void>>();

  /** The port, asked for the first time a file is opened (not when this module loads). */
  ready(): Promise<SyncPortLike> {
    return (this.portArrived ??= portSource().then((port) => {
      port.onmessage = (event) => this.receive(event.data);
      port.start?.();
      this.port = port;
      return port;
    }));
  }

  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    return () => this.controlHandlers.delete(handler);
  }

  /*
   * No transfer lists on this port: its other end is Electron main, whose MessagePortMain only
   * takes ports as transferables — a transferred ArrayBuffer does not arrive (measured: the
   * service saw no Auth at all). Posting copies the bytes, which is what crossing the process
   * does anyway.
   */
  post(message: SyncToMain): void {
    this.port?.postMessage(message);
  }

  sendFrame(frame: Uint8Array): void {
    // An exact-size copy: the provider's encoder buffer may be larger than the frame.
    this.port?.postMessage(frame.slice().buffer);
  }

  /**
   * Hold the open file's content and presence frames (`HELD_FRAME_TYPES`) until the returned release
   * is called — queued here, before the provider and the Y.Doc, then applied in the order they came.
   *
   * For editor bindings (`ime-hold.ts`): an input method's commit must not race a remote change
   * (L1 09-29: CodeMirror reads a commit a frame later on Android, and a remote transaction in
   * between drops it — the word goes back to pinyin). Nested holds stack; a lost release ends after
   * MAX_HOLD_MS. A connection that drops meanwhile discards what was held — the provider
   * resyncs from scratch on the next one, and frames of a dead connection must not be applied
   * to the new one.
   */
  hold(docName: string): () => void {
    const entry = this.holds.get(docName) ?? { depth: 0, frames: [] };
    entry.depth += 1;
    this.holds.set(docName, entry);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(guard);
      entry.depth -= 1;
      if (entry.depth > 0 || this.holds.get(docName) !== entry) return;
      this.holds.delete(docName);
      for (const frame of entry.frames) this.socket?.deliver(frame);
      for (const handler of [...(this.releaseHandlers.get(docName) ?? [])]) handler();
    };
    const guard = setTimeout(release, MAX_HOLD_MS);
    return release;
  }

  /** Whether the open file's frames are held right now (an input method is composing on it). */
  isHeld(docName: string): boolean {
    return this.holds.has(docName);
  }

  /** Told each time the open file's last hold ends (a compaction waiting on the composition goes on, 摩擦单 F71). */
  onReleased(docName: string, handler: () => void): () => void {
    const handlers = this.releaseHandlers.get(docName) ?? new Set<() => void>();
    handlers.add(handler);
    this.releaseHandlers.set(docName, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.releaseHandlers.get(docName) === handlers) this.releaseHandlers.delete(docName);
    };
  }

  /**
   * Show the open file's incoming updates to `see` while nothing of it is held. It may call
   * `hold(docName)` right there, synchronously; the update it was shown is then the first frame
   * held, so the order of what comes in is kept (L1 角度三: hold only what lands on the caret's
   * line before the caret). Every inspector of the file is asked — two editors on one file each
   * guard their own caret (the file's page shares one replica, F46); their holds nest. One that
   * throws is dropped and told through `failed`; the frame goes on as if it had not looked.
   */
  inspect(docName: string, see: (update: Uint8Array) => void, failed: (error: unknown) => void = () => undefined): () => void {
    const inspector: Inspector = { see, failed };
    const inspectors = this.inspectors.get(docName) ?? new Set<Inspector>();
    inspectors.add(inspector);
    this.inspectors.set(docName, inspectors);
    return () => {
      inspectors.delete(inspector);
      if (inspectors.size === 0 && this.inspectors.get(docName) === inspectors) this.inspectors.delete(docName);
    };
  }

  attach(socket: PortSocket): void {
    this.socket = socket;
    this.post({ t: 'hello' });
  }

  detach(socket: PortSocket): void {
    if (this.socket === socket) this.socket = null;
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (this.holds.size > 0 || this.inspectors.size > 0) {
        const bytes = new Uint8Array(data);
        const head = readFrameHead(bytes);
        const docName = head ? splitRoutingKey(head.key).docName : null;
        if (head && docName !== null && head.type === FRAME_TYPE.Sync && head.carriesUpdate && !this.holds.has(docName)) {
          const inspectors = this.inspectors.get(docName);
          const update = inspectors?.size ? readFrameUpdate(bytes) : null;
          if (inspectors && update) {
            for (const inspector of [...inspectors]) {
              try {
                inspector.see(update);
              } catch (error) {
                inspectors.delete(inspector);
                inspector.failed(error);
              }
            }
          }
        }
        const held = head && docName !== null && HELD_FRAME_TYPES.has(head.type) ? this.holds.get(docName) : undefined;
        if (held) {
          held.frames.push(data);
          return;
        }
      }
      this.socket?.deliver(data);
      return;
    }
    const message = data as SyncToPage;
    if (message.t === 'up') {
      this.up = true;
      this.socket?.opened();
      return;
    }
    if (message.t === 'down') {
      this.up = false;
      for (const held of this.holds.values()) held.frames.length = 0;
      this.socket?.closed(message.code, message.reason);
      return;
    }
    for (const handler of this.controlHandlers) handler(message);
  }

  get isUp(): boolean {
    return this.up;
  }
}

/**
 * The WebSocket the provider is handed. Open when main says the machine's connection is;
 * closed when main says it went away — the provider then retries, which sends `hello`
 * again, which is main's cue to drop this page's stale document connections.
 */
class PortSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = PortSocket.CONNECTING;
  binaryType: BinaryType = 'arraybuffer';
  /** Set by the provider to tell its sockets apart. */
  identifier?: number;

  constructor(private readonly link: SyncLink) {
    super();
    link.attach(this);
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== PortSocket.OPEN) return;
    const bytes =
      data instanceof Uint8Array ? data
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.link.sendFrame(bytes);
  }

  /** Ends, like a socket's `close()`, with a `close` event — dispatched now, so whoever closed it sees it closed before it opens another. */
  close(): void {
    if (this.readyState === PortSocket.CLOSED) return;
    this.readyState = PortSocket.CLOSED;
    this.link.detach(this);
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: 'closed', wasClean: true }));
  }

  /** main: the machine is connected. Async like a real socket: listeners are attached after construction. */
  opened(): void {
    if (this.readyState !== PortSocket.CONNECTING) return;
    queueMicrotask(() => {
      if (this.readyState !== PortSocket.CONNECTING) return;
      this.readyState = PortSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  closed(code: number, reason: string): void {
    if (this.readyState === PortSocket.CLOSED) return;
    this.readyState = PortSocket.CLOSED;
    this.link.detach(this);
    const event = Object.assign(new Event('close'), { code, reason, wasClean: false });
    queueMicrotask(() => this.dispatchEvent(event));
  }

  deliver(data: ArrayBuffer): void {
    if (this.readyState !== PortSocket.OPEN) return;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

let link: SyncLink | null = null;
let providerSocket: HocuspocusProviderWebsocket | null = null;

export function syncLink(): SyncLink {
  return (link ??= new SyncLink());
}

/**
 * The one provider socket this page's files share. Created once the port is here, so the
 * first `hello` has somewhere to go.
 */
export async function pageSocket(): Promise<HocuspocusProviderWebsocket> {
  const current = syncLink();
  await current.ready();
  if (providerSocket) {
    // Resting since the page's last file closed (`restPageSocket`): this open wakes it.
    if (!providerSocket.shouldConnect) void providerSocket.connect();
    return providerSocket;
  }
  const Socket = class extends PortSocket {
    constructor() {
      super(current);
      if (current.isUp) this.opened();
    }
  };
  providerSocket = new HocuspocusProviderWebsocket({
    // Never dialled: PortSocket ignores it. Named so a stack trace says what it is.
    url: 'gugu-files://main-relay',
    WebSocketPolyfill: Socket as unknown as typeof WebSocket,
    // Liveness of the real connection is main's job (it pings and says `down`). The
    // provider's own "no message in 30 s" check would tear down a healthy socket whenever
    // the page is alone in its open files.
    messageReconnectTimeout: 24 * 60 * 60 * 1000,
    delay: 500,
    minDelay: 500,
    maxDelay: 10_000,
  });
  return providerSocket;
}

/**
 * None of the page's files is syncing any more: the socket stops, and stops reconnecting. Left up empty,
 * it said `hello` again after every `down` and held main's connection open with nothing on it — closed by
 * the service every 30 s, reopened at once (摩擦单 F46). The next open wakes it (`pageSocket`).
 */
export function restPageSocket(): void {
  providerSocket?.disconnect();
}

export type { SyncLink, PortSocket };
