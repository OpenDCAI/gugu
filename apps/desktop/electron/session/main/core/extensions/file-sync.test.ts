import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import * as encoding from 'lib0/encoding';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  FRAME_TYPE,
  encodeAuthFrame,
  encodeCloseFrame,
  encodeSyncUpdateFrame,
  readFrameHead,
  readFrameUpdate,
  type SyncToPage,
} from '@shared/extensions/app-runtime-protocol';

/**
 * The file sync relay against a real WebSocket server standing in for the file service. The page
 * side is a fake MessagePort pair; what is judged is what reaches the service (bytes, order,
 * the credential in the subprotocol) and what the page is told.
 */

// ─── electron: a MessageChannelMain whose port2 the test holds as "the page" ─────
class FakePort extends EventEmitter {
  other!: FakePort;
  closed = false;
  postMessage(data: unknown) {
    if (this.closed) return;
    // Structured clone, like crossing processes: an ArrayBuffer arrives as a copy.
    const copy = data instanceof ArrayBuffer ? data.slice(0) : structuredClone(data);
    queueMicrotask(() => this.other.emit('message', { data: copy }));
  }
  start() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.other.emit('close');
  }
}
const pagePorts = vi.hoisted(() => new Map<number, unknown>());
const contentsById = vi.hoisted(() => new Map<number, unknown>());
vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
    }
  },
  webContents: { fromId: (id: number) => contentsById.get(id) },
}));

const granted = vi.hoisted(() => ({ caps: new Set<string>(['files:write']) }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ hasCapability: (_id: string, cap: string) => granted.caps.has(cap) }),
}));
// An unsigned token is enough: main only reads `sub` / `exp` from it; the fake service does not verify.
const token = vi.hoisted(() => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'user-a', exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.sig`;
});
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()), currentAccountAccessToken: async () => token }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

// ─── the stand-in file service ────────────────────────────────────────────────
let server: WebSocketServer;
const received: Uint8Array[] = [];
const offeredProtocols: string[] = [];
/** F16 Every connection the relay opened: what it offered, and the frames that came over it. */
const connections: Array<{ protocols: string[]; frames: Uint8Array[] }> = [];
let serviceSocket: WebSocket | null = null;
beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has('gugu-files.v1') ? 'gugu-files.v1' : false) });
  server.on('connection', (socket, request) => {
    const offered = String(request.headers['sec-websocket-protocol'] ?? '');
    offeredProtocols.push(offered);
    const connection = { protocols: offered.split(/,\s*/), frames: [] as Uint8Array[] };
    connections.push(connection);
    serviceSocket = socket;
    socket.on('message', (data: Buffer) => {
      received.push(new Uint8Array(data));
      connection.frames.push(new Uint8Array(data));
    });
  });
  await new Promise((r) => server.once('listening', r));
  process.env.GUGU_FILES_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  received.length = 0;
});

const { fileSync } = await import('./file-sync');

let nextId = 100;
/** A page: its webContents, the port main posted to it, and what it has been told. */
function openPage(extensionId = 'l3-probe') {
  const id = nextId++;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    postMessage: (_channel: string, _msg: unknown, ports: FakePort[]) => pagePorts.set(id, ports[0]),
  });
  contentsById.set(id, contents);
  const page = fileSync.pageFor(id, extensionId);
  const port = pagePorts.get(id) as FakePort;
  const told: SyncToPage[] = [];
  const frames: Uint8Array[] = [];
  port.on('message', ({ data }: { data: unknown }) => {
    if (data instanceof ArrayBuffer) frames.push(new Uint8Array(data));
    else told.push(data as SyncToPage);
  });
  return { id, contents, page, port, told, frames };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 80));
const buffer = (bytes: Uint8Array) => bytes.slice().buffer;

describe('app file sync relay', () => {
  it('says up once the machine is connected, and carries the credential in the subprotocol only', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    expect(offeredProtocols.at(-1)?.split(/,\s*/)).toEqual(['gugu-files.v1', `bearer.${token}`]);
    const auth = encodeAuthFrame('doc@0\u0000s1', '');
    p.port.postMessage(buffer(auth));
    await until(() => received.length === 1);
    expect(received[0]).toEqual(auth);
  });

  // S15 (原则 9): the credential stays in main. Nothing the page is told, and no frame it is handed, carries it — through
  // a whole round: up, its Auth relayed, the service's answer routed back. Control: the connection main offers does.
  it('never hands the page the credential: not in what it is told, not in the frames it gets', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'cred@0', itemId: 'cred', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    p.port.postMessage(buffer(encodeAuthFrame('cred@0\u0000c1', '')));
    await until(() => received.length === 1);
    const key = new TextEncoder().encode('cred@0\u0000c1');
    serviceSocket!.send(Uint8Array.from([key.length, ...key, FRAME_TYPE.Auth, 2]));
    await until(() => p.frames.length === 1);
    const handed = JSON.stringify(p.told) + p.frames.map((frame) => new TextDecoder().decode(frame)).join('');
    expect(handed).not.toContain(token);
    expect(offeredProtocols.at(-1)).toContain(token);
  });

  it('drops a frame for a file the page was never granted, and tells it', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    p.port.postMessage(buffer(encodeAuthFrame('other@0\u0000s1', '')));
    await until(() => p.told.some((m) => m.t === 'denied'));
    await settle();
    expect(p.told.find((m) => m.t === 'denied')).toMatchObject({ reason: 'not-granted' });
    expect(received).toHaveLength(0);
    // Control: the granted open file on the same port goes through.
    p.port.postMessage(buffer(encodeAuthFrame('doc@0\u0000s2', '')));
    await until(() => received.length === 1);
  });

  it('read-only: an update is dropped, a Step 1 goes through', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'ro@0', itemId: 'ro', access: 'ro', needs: 'files:write' });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'x');
    p.port.postMessage(buffer(encodeSyncUpdateFrame('ro@0\u0000s1', Y.encodeStateAsUpdate(doc))));
    await until(() => p.told.some((m) => m.t === 'denied'));
    expect(p.told.find((m) => m.t === 'denied')).toMatchObject({ reason: 'read-only' });
    // The key opened as a provider opens it (its Auth), then a Step 1: key, Sync, step 0, a state vector.
    p.port.postMessage(buffer(encodeAuthFrame('ro@0\u0000s1', '')));
    const sv = Y.encodeStateVector(new Y.Doc());
    const key = new TextEncoder().encode('ro@0\u0000s1');
    const frame = Uint8Array.from([key.length, ...key, FRAME_TYPE.Sync, 0, sv.length, ...sv]);
    p.port.postMessage(buffer(frame));
    await until(() => received.length === 2);
    expect(readFrameHead(received[1]!)).toMatchObject({ type: FRAME_TYPE.Sync, carriesUpdate: false });
  });

  it('read-only: Step 2 finishes the handshake without sending content or deletion history', async () => {
    const p = openPage();
    const grant = { docName: 'reader@0', itemId: 'reader', access: 'ro' as 'ro' | 'rw', needs: null };
    fileSync.grant(p.page, grant);
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    const key = 'reader@0\u0000s1';
    p.port.postMessage(buffer(encodeAuthFrame(key, '')));
    await until(() => received.length === 1);
    const doc = new Y.Doc();
    doc.getMap('root').set('status', 'old');
    doc.getMap('root').set('status', 'current');
    // Even an up-to-date reader sends the service's delete set back; a state vector omits deletions.
    for (const vector of [Y.encodeStateVector(doc), Y.encodeStateVector(new Y.Doc())]) {
      const e = encoding.createEncoder();
      encoding.writeVarString(e, key);
      encoding.writeVarUint(e, FRAME_TYPE.Sync);
      syncProtocol.writeSyncStep2(e, doc, vector);
      const step2 = encoding.toUint8Array(e);
      expect(readFrameHead(step2)?.carriesUpdate).toBe(true);
      const before = received.length;
      p.port.postMessage(buffer(step2));
      await until(() => received.length === before + 1);
      expect(readFrameHead(received.at(-1)!)).toMatchObject({ syncStep: syncProtocol.messageYjsSyncStep2, carriesUpdate: false });
      expect(readFrameUpdate(received.at(-1)!)).toEqual(Uint8Array.of(0, 0));
      expect(p.told.filter((m) => m.t === 'denied')).toEqual([]);
      // Control: the identical frame on a writable grant keeps all its content.
      grant.access = 'rw';
      p.port.postMessage(buffer(step2));
      await until(() => received.length === before + 2);
      expect(received.at(-1)).toEqual(step2);
      grant.access = 'ro';
    }
    fileSync.pageGone(p.id);
    await until(() => readFrameHead(received.at(-1)!)?.type === FRAME_TYPE.Close);
    expect(received.at(-1)).toEqual(encodeCloseFrame(key));
  });

  it('a page that goes away: what it handed over lands first, then a Close for each of its keys', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'last word');
    const auth = encodeAuthFrame('doc@0\u0000s4', '');
    const update = encodeSyncUpdateFrame('doc@0\u0000s4', Y.encodeStateAsUpdate(doc));
    p.port.postMessage(buffer(auth));
    p.port.postMessage(buffer(update));
    await settle();
    p.contents.emit('destroyed');
    await until(() => received.length === 3);
    expect(received).toEqual([auth, update, encodeCloseFrame('doc@0\u0000s4')]);
  });

  it('delivers a will the page left behind: Auth, the update, and Close once the service saved it', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'typed while offline');
    const update = Y.encodeStateAsUpdate(doc);
    p.port.postMessage({ t: 'will', docName: 'doc@0', update: buffer(update) });
    await settle();
    p.port.close();
    await until(() => received.length === 2);
    const auth = readFrameHead(received[0]!)!;
    expect(auth.type).toBe(FRAME_TYPE.Auth);
    expect(auth.key.startsWith('doc@0\u0000will-')).toBe(true);
    expect(received[1]).toEqual(encodeSyncUpdateFrame(auth.key, update));
    // The service answers: authenticated, then saved.
    const keyBytes = new TextEncoder().encode(auth.key);
    serviceSocket!.send(Uint8Array.from([keyBytes.length, ...keyBytes, FRAME_TYPE.Auth, 2]));
    serviceSocket!.send(Uint8Array.from([keyBytes.length, ...keyBytes, FRAME_TYPE.SyncStatus, 1]));
    await until(() => received.length === 3);
    expect(received[2]).toEqual(encodeCloseFrame(auth.key));
  });

  it('a capability taken back mid-session: the next frame revokes the file instead of going out', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'cap@0', itemId: 'cap', access: 'rw', needs: 'files:write' });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    granted.caps.delete('files:write');
    try {
      p.port.postMessage(buffer(encodeAuthFrame('cap@0\u0000s1', '')));
      await until(() => p.told.some((m) => m.t === 'revoked'));
      await settle();
      expect(p.told.find((m) => m.t === 'revoked')).toMatchObject({ docName: 'cap@0', reason: 'capability' });
      expect(received).toHaveLength(0);
    } finally {
      granted.caps.add('files:write');
    }
  });

  it('answers the service ping itself and keeps it from the pages', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    serviceSocket!.send(Uint8Array.of(FRAME_TYPE.Ping));
    await until(() => received.some((f) => f.length === 1 && f[0] === FRAME_TYPE.Pong));
    await settle();
    expect(p.frames).toHaveLength(0);
  });

  it('the service closing a document for `deleted` revokes the file; `rate-limited` is only passed on', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'del@0', itemId: 'del', access: 'rw', needs: null });
    fileSync.grant(p.page, { docName: 'busy@0', itemId: 'busy', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    p.port.postMessage(buffer(encodeAuthFrame('del@0' + '\u0000' + 'k1', '')));
    p.port.postMessage(buffer(encodeAuthFrame('busy@0' + '\u0000' + 'k2', '')));
    await until(() => received.length === 2);
    const close = (key: string, reason: string) => {
      const k = new TextEncoder().encode(key);
      const r = new TextEncoder().encode(reason);
      return Uint8Array.from([k.length, ...k, FRAME_TYPE.Close, r.length, ...r]);
    };
    serviceSocket!.send(close('del@0' + '\u0000' + 'k1', 'deleted'));
    serviceSocket!.send(close('busy@0' + '\u0000' + 'k2', 'rate-limited'));
    await until(() => p.frames.length === 2 && p.told.some((m) => m.t === 'revoked'));
    await settle();
    expect(p.told.filter((m) => m.t === 'revoked')).toEqual([{ t: 'revoked', docName: 'del@0', reason: 'deleted' }]);
    // The page's provider, seeing its connection closed, may send a Close of its own: the key is
    // no longer held, so it must not reach the service (it would close the next connection).
    received.length = 0;
    p.port.postMessage(buffer(encodeCloseFrame('busy@0' + '\u0000' + 'k2')));
    await settle();
    expect(received).toHaveLength(0);
    // …while re-authenticating on the rate-limited open file is let through.
    p.port.postMessage(buffer(encodeAuthFrame('busy@0' + '\u0000' + 'k2', '')));
    await until(() => received.length === 1);
  });

  // S15 (原则 9): a person taken out of the group is cut off at once — the page is told, and nothing it sends on the
  // file afterwards reaches the service. Control: another file of the page, still granted, goes on through.
  it('the service closing a document for `removed-from-group` revokes the file at once; what the page sends after goes nowhere', async () => {
    const p = openPage();
    fileSync.grant(p.page, { docName: 'gone@0', itemId: 'gone', access: 'rw', needs: null });
    fileSync.grant(p.page, { docName: 'kept@0', itemId: 'kept', access: 'rw', needs: null });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    p.port.postMessage(buffer(encodeAuthFrame('gone@0' + '\u0000' + 'k1', '')));
    p.port.postMessage(buffer(encodeAuthFrame('kept@0' + '\u0000' + 'k2', '')));
    await until(() => received.length === 2);
    const k = new TextEncoder().encode('gone@0' + '\u0000' + 'k1');
    const r = new TextEncoder().encode('removed-from-group');
    serviceSocket!.send(Uint8Array.from([k.length, ...k, FRAME_TYPE.Close, r.length, ...r]));
    await until(() => p.told.some((m) => m.t === 'revoked'));
    expect(p.told.filter((m) => m.t === 'revoked')).toEqual([{ t: 'revoked', docName: 'gone@0', reason: 'removed-from-group' }]);
    received.length = 0;
    p.port.postMessage(buffer(encodeAuthFrame('gone@0' + '\u0000' + 'k1', '')));
    p.port.postMessage(buffer(encodeAuthFrame('kept@0' + '\u0000' + 'k2', '')));
    await until(() => received.length === 1);
    await settle();
    expect(received).toHaveLength(1);
    expect(p.told.some((m) => m.t === 'denied' && String((m as { key?: string }).key).startsWith('gone@0'))).toBe(true);
  });

  it('routes the service reply to the page that owns the key, and to no other', async () => {
    const one = openPage();
    const two = openPage();
    for (const p of [one, two]) {
      fileSync.grant(p.page, { docName: 'doc@0', itemId: 'doc', access: 'rw', needs: null });
      p.port.postMessage({ t: 'hello' });
      await until(() => p.told.some((m) => m.t === 'up'));
    }
    one.port.postMessage(buffer(encodeAuthFrame('doc@0\u0000one', '')));
    two.port.postMessage(buffer(encodeAuthFrame('doc@0\u0000two', '')));
    await until(() => received.length === 2);
    const key = new TextEncoder().encode('doc@0\u0000two');
    serviceSocket!.send(Uint8Array.from([key.length, ...key, FRAME_TYPE.Auth, 2]));
    await until(() => two.frames.length === 1);
    await settle();
    expect(one.frames).toHaveLength(0);
    // The same key from another page is refused: a page cannot speak on a key another page owns.
    one.port.postMessage(buffer(encodeAuthFrame('doc@0\u0000two', '')));
    await until(() => one.told.some((m) => m.t === 'denied'));
    expect(one.told.find((m) => m.t === 'denied')).toMatchObject({ reason: 'key-in-use' });
  });
});

// 摩擦单 F16:程序代本机主人的 agent 打开的文件,走一条「以这个 agent 身份」的连接(子协议多一项 as.<agent>),
// 文件服务按 agent 自己判权、按 agent 盖章;主人自己的文件照旧走主人的连接。
describe('a file opened for one of the person\'s agents (F16)', () => {
  const AGENT = '0a000000-0000-4000-8000-0000000000f6';

  it('rides a connection acting as that agent — as.<agent> offered once — while the person\'s own file stays on theirs', async () => {
    const p = openPage('board-program');
    fileSync.grant(p.page, { docName: 'mine@0', itemId: 'mine', access: 'rw', needs: null });
    fileSync.grant(p.page, { docName: 'handed@0', itemId: 'handed', access: 'rw', needs: null, asAgent: AGENT });
    p.port.postMessage({ t: 'hello' });
    await until(() => p.told.some((m) => m.t === 'up'));
    const mine = encodeAuthFrame('mine@0\u0000s1', '');
    const handed = encodeAuthFrame('handed@0\u0000s1', '');
    p.port.postMessage(buffer(mine));
    p.port.postMessage(buffer(handed));
    // The person's connection may be one an earlier case opened (the relay is one per process).
    const carrying = (frame: Uint8Array) =>
      connections.find((c) => c.frames.some((f) => f.length === frame.length && f.every((b, i) => b === frame[i])));
    await until(() => carrying(mine) !== undefined && carrying(handed) !== undefined);
    expect(carrying(handed)?.protocols).toEqual(['gugu-files.v1', `bearer.${token}`, `as.${AGENT}`]);
    expect(carrying(handed)?.frames).toEqual([handed]);
    expect(carrying(mine)?.protocols, 'the person\'s own file on a connection with no as.').toEqual(['gugu-files.v1', `bearer.${token}`]);
  });
});
