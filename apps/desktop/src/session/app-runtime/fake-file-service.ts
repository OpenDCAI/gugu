import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { FRAME_TYPE, splitRoutingKey, type AppFileOpened } from '@shared/extensions/app-runtime-protocol';

/**
 * For the runtime's tests: one page (the runtime loaded afresh, its module state its own) whose sync port reaches a
 * small in-test file service speaking the Hocuspocus 4.7 frames the real one does (Auth → Authenticated; SyncStep1 →
 * SyncStep2 + its own SyncStep1; an update → SyncStatus, and to everyone else on the file).
 */

type Frame = Uint8Array;
const AUTH_PERMISSION_DENIED = 1;
const AUTHENTICATED = 2;

export class FakeService {
  readonly docs = new Map<string, Y.Doc>();
  /** routing key → the page it belongs to (one page here). */
  readonly keys = new Set<string>();
  /** Swallows sync traffic: the file service went silent. */
  silent = false;
  /** Applies what the page sends but confirms none of it until `releaseAcks` (a slow service: the page's confirmed base goes stale). */
  holdAcks = false;
  private readonly heldAcks: string[] = [];
  /** Holds every sync frame the page sends until `releaseSync` (a service slow to answer: the page is not synced yet). */
  holdSync = false;
  private readonly heldSync: ArrayBuffer[] = [];
  /** The wills the page left with main (`{ t: 'will' }`): what it had not got confirmed, kept in case it goes. */
  readonly wills: { docName: string }[] = [];
  /** Answers an Auth with main's `denied` instead (`key-in-use`). */
  refuseAuth = false;
  hellos = 0;
  /** Each awareness (presence) frame the page sent, its update as `y-protocols/awareness` encodes it. */
  readonly awareness: Uint8Array[] = [];
  /** Each stateless message the page sent (`drained`), with the routing key it came on. */
  readonly stateless: { key: string; payload: string }[] = [];
  /** A document moved to a new epoch (a compaction): its old name is refused as `stale-epoch:<n>`, as the real service does. */
  readonly superseded = new Map<string, number>();
  /**
   * Frames that came on a key this service had closed, held until that key authenticates again and then handled in
   * order — Hocuspocus 4.7's `ClientConnection` queue. A Close held there closes the new connection ('provider_initiated').
   */
  readonly queued = new Map<string, ArrayBuffer[]>();
  private readonly closedKeys = new Set<string>();
  /**
   * A key whose Auth was refused, until the page has heard it: what the page sent behind that Auth waited in the queue
   * and goes with the refusal (4.7 drops the queue then). Anything on the key after that opens a new queue that never
   * clears — it counts toward `maxPendingDocuments` (100), past which the whole socket is reset.
   */
  private readonly refusing = new Set<string>();
  toPage: ((event: { data: unknown }) => void) | null = null;

  docOf(docName: string): Y.Doc {
    let doc = this.docs.get(docName);
    if (!doc) {
      doc = new Y.Doc();
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        for (const key of this.keys) {
          if (key === origin || splitRoutingKey(key).docName !== docName) continue;
          this.send(key, (e) => {
            encoding.writeVarUint(e, FRAME_TYPE.Sync);
            syncProtocol.writeUpdate(e, update);
          });
        }
      });
      this.docs.set(docName, doc);
    }
    return doc;
  }

  text(docName: string): string {
    return this.docOf(docName).getText('content').toString();
  }

  /** Someone else types into the file at `index`. */
  insertAt(docName: string, index: number, text: string): void {
    this.docOf(docName).getText('content').insert(index, text);
  }

  /** Someone else types into the file. */
  write(docName: string, text: string): void {
    const content = this.docOf(docName).getText('content');
    content.insert(content.length, text);
  }

  /** The routing keys the page has open on `docName`. */
  keysOf(docName: string): string[] {
    return [...this.keys].filter((key) => splitRoutingKey(key).docName === docName);
  }

  /** A stateless message to every connection on `docName` (`compact`, `resume`). */
  say(docName: string, payload: unknown): void {
    for (const key of this.keysOf(docName)) {
      this.send(key, (e) => {
        encoding.writeVarUint(e, FRAME_TYPE.Stateless);
        encoding.writeVarString(e, JSON.stringify(payload));
      });
    }
  }

  /** Closes every connection on `docName`, as Hocuspocus does (`compacted:<n>`, `rate-limited`, `deleted`, …). */
  closeDocument(docName: string, reason: string): void {
    for (const key of this.keysOf(docName)) {
      this.keys.delete(key);
      this.closedKeys.add(key);
      this.send(key, (e) => {
        encoding.writeVarUint(e, FRAME_TYPE.Close);
        encoding.writeVarString(e, reason);
      });
    }
  }

  /**
   * A hot compaction as files-core runs it (摩擦单 F71): `compact` to every connection, wait for each one's `drained`
   * (`drainMs`, then `resume` and false), rebuild the content into `next`, close every connection with `compacted:<n>`.
   * `drain: false` is the old way, for the control: close at once and let the page replay what it had not got confirmed.
   */
  async compact(docName: string, next: string, options: { drain?: boolean; drainMs?: number } = {}): Promise<boolean> {
    const keys = this.keysOf(docName);
    if (options.drain !== false) {
      const seen = this.stateless.length;
      this.say(docName, { t: 'compact' });
      const drained = () =>
        keys.every((key) => this.stateless.slice(seen).some((m) => m.key === key && JSON.parse(m.payload).t === 'drained'));
      const t0 = Date.now();
      while (!drained()) {
        if (Date.now() - t0 > (options.drainMs ?? 1000)) {
          this.say(docName, { t: 'resume' });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    // The content with its types (collaborative text stays text), as `rebuildDoc` keeps them; history is no matter here.
    Y.applyUpdate(this.docOf(next), Y.encodeStateAsUpdate(this.docOf(docName)));
    const epoch = Number(next.slice(next.lastIndexOf('@') + 1));
    this.superseded.set(docName, epoch);
    this.closeDocument(docName, `compacted:${epoch}`);
    return true;
  }

  /** What main says to the page on its port (`revoked`, `back`), in order with the frames. */
  control(message: unknown): void {
    this.post(message);
  }

  private post(data: unknown): void {
    setTimeout(() => this.toPage?.({ data }), 0);
  }

  private send(key: string, body: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, key);
    body(encoder);
    this.post(encoding.toUint8Array(encoder).slice().buffer);
  }

  /** What the page posted on its sync port. */
  fromPage(message: unknown): void {
    if (!(message instanceof ArrayBuffer)) {
      if ((message as { t?: string })?.t === 'hello') {
        this.hellos += 1;
        this.post({ t: 'up' });
      }
      if ((message as { t?: string })?.t === 'will') this.wills.push({ docName: (message as { docName: string }).docName });
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(message) as Frame);
    const key = decoding.readVarString(decoder);
    const type = decoding.readVarUint(decoder);
    const { docName } = splitRoutingKey(key);
    if (type === FRAME_TYPE.Auth) {
      if (this.refuseAuth) {
        this.post({ t: 'denied', key, reason: 'key-in-use' });
        return;
      }
      const epoch = this.superseded.get(docName);
      if (epoch !== undefined) {
        this.queued.delete(key);
        this.closedKeys.add(key);
        this.refusing.add(key);
        const refusal = encoding.createEncoder();
        encoding.writeVarString(refusal, key);
        encoding.writeVarUint(refusal, FRAME_TYPE.Auth);
        encoding.writeVarUint(refusal, AUTH_PERMISSION_DENIED);
        encoding.writeVarString(refusal, `stale-epoch:${epoch}`);
        const data = encoding.toUint8Array(refusal).slice().buffer;
        // Heard from the moment it is delivered: what the page sends from then on — its reaction too — comes after it.
        setTimeout(() => {
          this.refusing.delete(key);
          this.toPage?.({ data });
        }, 0);
        return;
      }
      this.keys.add(key);
      this.closedKeys.delete(key);
      this.send(key, (e) => {
        encoding.writeVarUint(e, FRAME_TYPE.Auth);
        encoding.writeVarUint(e, AUTHENTICATED);
        encoding.writeVarString(e, 'read-write');
      });
      const held = this.queued.get(key) ?? [];
      this.queued.delete(key);
      for (const frame of held) this.fromPage(frame);
      return;
    }
    if (this.refusing.has(key)) return;
    if (this.closedKeys.has(key)) {
      this.queued.set(key, [...(this.queued.get(key) ?? []), message]);
      return;
    }
    if (type === FRAME_TYPE.Close) {
      // Hocuspocus answers a Close on a live connection by closing it.
      if (this.keys.delete(key)) {
        this.send(key, (e) => {
          encoding.writeVarUint(e, FRAME_TYPE.Close);
          encoding.writeVarString(e, 'provider_initiated');
        });
      }
      return;
    }
    if (type === FRAME_TYPE.Awareness) {
      this.awareness.push(decoding.readVarUint8Array(decoder));
      return;
    }
    if (type === FRAME_TYPE.Stateless) {
      this.stateless.push({ key, payload: decoding.readVarString(decoder) });
      return;
    }
    if (type !== FRAME_TYPE.Sync || this.silent || !this.keys.has(key)) return;
    if (this.holdSync) {
      this.heldSync.push(message);
      return;
    }
    const doc = this.docOf(docName);
    const reply = encoding.createEncoder();
    encoding.writeVarString(reply, key);
    encoding.writeVarUint(reply, FRAME_TYPE.Sync);
    const kind = syncProtocol.readSyncMessage(decoder, reply, doc, key);
    if (kind === syncProtocol.messageYjsSyncStep1) {
      this.post(encoding.toUint8Array(reply).slice().buffer);
      this.send(key, (e) => {
        encoding.writeVarUint(e, FRAME_TYPE.Sync);
        syncProtocol.writeSyncStep1(e, doc);
      });
      return;
    }
    if (this.holdAcks) {
      this.heldAcks.push(key);
      return;
    }
    this.ack(key);
  }

  /** The sync frames held back (`holdSync`), handled now in the order they came. */
  releaseSync(): void {
    this.holdSync = false;
    for (const frame of this.heldSync.splice(0)) this.fromPage(frame);
  }

  /** The confirmations held back (`holdAcks`), sent now to the connections still open. */
  releaseAcks(): void {
    this.holdAcks = false;
    for (const key of this.heldAcks.splice(0)) if (this.keys.has(key)) this.ack(key);
  }

  private ack(key: string): void {
    this.send(key, (e) => {
      encoding.writeVarUint(e, FRAME_TYPE.SyncStatus);
      encoding.writeVarUint(e, 1);
    });
  }
}

export function fileOpened(type: 'text' | 'json'): AppFileOpened {
  return {
    entry: {
      id: 'item-1',
      chat: 'chat-1',
      name: type === 'json' ? 'board.json' : 'notes.md',
      savedName: type === 'json' ? 'board.json' : 'notes.md',
      contentType: type === 'json' ? 'application/json' : 'text/markdown',
      type,
      parentId: null,
      path: type === 'json' ? 'board.json' : 'notes.md',
      systemRole: null,
      canDelete: true,
      suffix: type === 'json' ? '.json' : '.md',
      displayName: type === 'json' ? 'board' : 'notes',
      claimedBy: null,
      appState: false,
      size: 0,
      version: 1,
      createdAt: null,
      updatedAt: null,
      createdBy: null,
      updatedBy: null,
      sourceMessageIds: [],
    },
    docName: 'item-1@1',
    access: 'rw',
    self: { userId: 'user:a', name: 'A' },
  };
}

/**
 * A page with the runtime loaded afresh, its sync port on a fake file service; `open()` opens item-1.
 * `checkPage`: the check's page (摩擦单 F69), its host reporting counts to `host.checkPage.report`.
 */
export async function loadPage<File>(type: 'text' | 'json' = 'text', options: { checkPage?: boolean } = {}) {
  vi.resetModules();
  const service = new FakeService();
  const { setSyncPortSource } = await import('./sync-link');
  setSyncPortSource(async () => {
    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => service.fromPage(message),
    };
    service.toPage = (event) => port.onmessage?.(event);
    return port;
  });
  const runtime = await import('./files-entry');
  const { bindText } = runtime;
  const { createGugu } = await import('./create-gugu');
  const { STALL_MS, internals } = await import('./open-file');
  const opened = fileOpened(type);
  const host = {
    apiVersion: EXTENSION_API_VERSION,
    reportError: vi.fn(async (_message: string) => undefined),
    onFilesChanged: () => () => undefined,
    appFiles: {
      open: vi.fn(async () => structuredClone(opened)),
      // The file's current epoch, as main's grant would say after a compaction moved it.
      reopen: vi.fn(async () => {
        let docName = opened.docName;
        for (let epoch = service.superseded.get(docName); epoch !== undefined; epoch = service.superseded.get(docName)) {
          docName = `${docName.slice(0, docName.lastIndexOf('@') + 1)}${epoch}`;
        }
        return { ...structuredClone(opened), docName };
      }),
      close: vi.fn(async (_args: { docName: string }) => undefined),
    },
    clipboard: { writeText: async () => undefined },
    ...(options.checkPage ? { checkPage: { report: vi.fn(async (_counts: unknown) => undefined) } } : {}),
  };
  const gugu = createGugu(host as never, { files: async () => runtime }) as { files: { open(file: unknown): Promise<File> } };
  const open = () => gugu.files.open({ id: 'item-1' });
  return { service, host, open, STALL_MS, internals, bindText };
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms: ${check.toString()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
