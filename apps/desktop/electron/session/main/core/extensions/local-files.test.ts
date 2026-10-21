import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeAuthFrame, type SyncToPage } from '@shared/extensions/app-runtime-protocol';
import { FileSyncRelay, type FileSyncPlatform, type PageSync } from '@shared/extensions/file-sync-core';
import { FilesRuntime, type FileChangeUpdate } from '@gugu/session-core/files';
import type { WatchEvent } from '@gugu/session-core/services/fs-watch/api';
import type { WatchSink } from '../../../../../../../packages/session-core/src/services/fs-watch/impl/backend';
import { createWatchService } from '../../../../../../../packages/session-core/src/services/fs-watch/impl/watch-service';
import { awaitFact } from '../../../../../../../tests/support/awaitFact';
import { createLocalAppFiles, createLocalFileService, type LocalSurface } from './local-files';

/**
 * `gugu.files` on a task's working copy, end to end in one process: the real relay (`file-sync-core.ts`) with the local
 * file service as its `connectLocal`, stock Hocuspocus providers as the pages (over a port that stands in for the
 * page's MessagePort, as the runtime's PortSocket does), and a working copy in a temporary directory. What is judged is
 * what the pages hold and what is on the disk.
 */

/** The session whose working copy these pages name (`{ session, id }`, 真源原则 13). */
const SESSION = 'session-1';
let root: string;
let service: ReturnType<typeof createLocalFileService>;
let relay: FileSyncRelay;
let files: ReturnType<typeof createLocalAppFiles>;
let warnings: string[];
const pages: Page[] = [];
/**
 * What the service hears of the disk: the working copy's change stream — the real watch service (its batching),
 * FileChanges and `heard`, over a backend that stands in for the OS. Each change a test makes is reported the way the
 * darwin transport (`fsevents-transport.ts`) reports what fseventsd sends for it, read off mac1 (2026-10-17):
 * a new or removed entry comes with its folder (flags 131328: a created folder → `create`), the entry as `create`
 * (69888 new, 70912 written over) or `delete` (70400); a folder taken with what is in it comes as each of them,
 * deepest first (131840 → `delete`). Linux reports a folder taken as the one name its watched parent saw; the cell that
 * says so reports it that way. Whether the OS delivers at all is not this file's question, and no test here can make it
 * deterministic: fseventsd under load is minutes late, or never sends (#7371). The service's own writes are echoed only
 * in the cell about that echo.
 */
const sinks = new Map<string, WatchSink>();
const watcher = createWatchService({
  backend: {
    async subscribe(key, sink, scope) {
      sinks.set(key.root, sink);
      scope.add(() => {
        sinks.delete(key.root);
      });
    },
  },
});
const runtime = new FilesRuntime({ watcher });
/** One batch from the OS, a moment after the change (never inside the call that made it). */
function reported(events: WatchEvent[]) {
  setTimeout(() => {
    for (const [watched, sink] of sinks) {
      const mine = events.filter((event) => event.path === watched || event.path.startsWith(watched + path.sep));
      if (mine.length > 0) sink.events(mine);
    }
  }, 0);
}
let feed: { unsubscribe(): void } | null = null;
/** Every update the change stream handed the service, in order. */
let heard: FileChangeUpdate[] = [];
/** The file service side, per test: by default there is none (a working copy never reaches it) and nobody is signed in. */
const remote: { token: string | null; connect: FileSyncPlatform['connect'] } = { token: null, connect: noFileService };
function noFileService(): never {
  throw new Error('a working copy never reaches the file service');
}

/**
 * Wait for a fact, not a clock (#4357): a write lands within the service's debounce (1 s, at most 5 s) of a loaded
 * machine's time, not ours. Wait for the fact to arrive (something was heard, the disk changed), then assert the exact
 * value.
 */
const until = (check: () => boolean) => awaitFact(check.toString(), () => (check() ? true : undefined));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (rel: string, data: string | Uint8Array) => {
  const abs = path.join(root, rel);
  const isNew = !fs.existsSync(abs);
  fs.writeFileSync(abs, data);
  reported(isNew ? [{ kind: 'create', path: path.dirname(abs) }, { kind: 'create', path: abs }] : [{ kind: 'create', path: abs }]);
};
/** `mkdir -p`: each folder made, as created. */
const mkdirs = (rel: string) => {
  const made = fs.mkdirSync(path.join(root, rel), { recursive: true });
  if (!made) return;
  const created: WatchEvent[] = [];
  for (let dir = path.join(root, rel); dir.length >= made.length; dir = path.dirname(dir)) created.unshift({ kind: 'create', path: dir });
  reported(created);
};
/** `rm` / `rm -r`: a file with its folder; a folder with everything in it, deepest first. */
const rm = (rel: string) => {
  const abs = path.join(root, rel);
  const folder = fs.statSync(abs).isDirectory();
  const taken: WatchEvent[] = [];
  const walk = (at: string) => {
    if (fs.statSync(at).isDirectory()) for (const name of fs.readdirSync(at)) walk(path.join(at, name));
    taken.push({ kind: 'delete', path: at });
  };
  walk(abs);
  fs.rmSync(abs, { recursive: true });
  reported(folder ? taken : [{ kind: 'create', path: path.dirname(abs) }, ...taken]);
};

/** One App page: its relay port, the socket its provider thinks it has, and the files it opened. */
class Page {
  readonly sync: PageSync;
  socket: (EventTarget & { readyState: number; deliver(data: ArrayBuffer): void; opened(): void; closed(code: number, reason: string): void }) | null = null;
  readonly told: SyncToPage[] = [];
  private socketProvider: HocuspocusProviderWebsocket | null = null;
  readonly surface: LocalSurface;

  constructor(
    readonly id: number,
    filePath: string | null,
  ) {
    this.surface = { pageId: id, extensionId: 'ext', place: { session: SESSION }, workspaceRoot: root, filePath };
    this.sync = relay.attachPage(id, 'ext', {
      // A MessagePort delivers later, and a copy.
      post: (message) => setTimeout(() => this.fromMain(message instanceof ArrayBuffer ? message.slice(0) : message), 0),
      close: () => undefined,
    });
    pages.push(this);
  }

  /** The provider socket, made on the first open as the runtime makes it (`pageSocket` after `files.open`). */
  get ws(): HocuspocusProviderWebsocket {
    if (this.socketProvider) return this.socketProvider;
    // What the socket does to this page: become its socket, and send to main later (a MessagePort does).
    const adopt = (socket: NonNullable<Page['socket']>) => (this.socket = socket);
    const toMain = (message: unknown) => setTimeout(() => relay.fromPage(this.sync, message), 0);
    const Socket = class extends EventTarget {
      readyState = 0;
      binaryType = 'arraybuffer';
      constructor() {
        super();
        adopt(this);
        toMain({ t: 'hello' });
      }
      send(data: ArrayBufferLike | ArrayBufferView) {
        if (this.readyState !== 1) return;
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        toMain(bytes.slice().buffer);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: 'closed', wasClean: true }));
      }
      opened() {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }
      closed(code: number, reason: string) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: false }));
      }
      deliver(data: ArrayBuffer) {
        if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data }));
      }
    };
    this.socketProvider = new HocuspocusProviderWebsocket({
      url: 'gugu-files://test',
      WebSocketPolyfill: Socket as unknown as typeof WebSocket,
      messageReconnectTimeout: 24 * 3600_000,
      delay: 50,
      minDelay: 50,
      maxDelay: 500,
    });
    return this.socketProvider;
  }

  private fromMain(message: unknown) {
    if (message instanceof ArrayBuffer) {
      this.socket?.deliver(message);
      return;
    }
    const control = message as SyncToPage;
    this.told.push(control);
    if (control.t === 'up') this.socket?.opened();
    if (control.t === 'down') this.socket?.closed(control.code, control.reason);
  }

  /** `gugu.files.open(ref)` (none: the file the host handed the page) and a provider on what it grants, resolved once synced. */
  async open(ref?: string) {
    return this.provide(await files.open(this.surface, { ref: { session: SESSION, id: ref ?? this.surface.filePath ?? '' } }));
  }

  /** What the runtime does when main says `back` (or `stale-epoch`): `files.reopen`, and a provider on the new grant. */
  async reopen(itemId: string) {
    return this.provide(await files.reopen(this.surface, { ref: { session: SESSION, id: itemId } }));
  }

  private async provide(opened: Awaited<ReturnType<typeof files.open>>) {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({ websocketProvider: this.ws, name: opened.docName, document: doc, token: '', sessionAwareness: true });
    const stateless: string[] = [];
    provider.on('stateless', ({ payload }: { payload: string }) => stateless.push(payload));
    const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
    const closed: string[] = [];
    provider.on('close', ({ event }: { event?: { reason?: unknown } }) => closed.push(String(event?.reason ?? '')));
    provider.attach();
    await synced;
    return { opened, doc, provider, text: () => doc.getText('content'), root: () => doc.getMap('root'), stateless, closed };
  }

  gone() {
    this.socketProvider?.destroy();
    relay.pageGone(this.id);
  }
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-local-files-')));
  warnings = [];
  remote.token = null;
  remote.connect = noFileService;
  relay = new FileSyncRelay({
    serviceUrl: () => 'ws://file-service',
    connect: (url, protocols, events) => remote.connect(url, protocols, events),
    connectLocal: (events) => service.connect(events),
    awaitLocalReturn: (docName, back) => service.awaitReturn(docName, back),
    token: async () => remote.token,
    hasCapability: () => true,
    warn: (message) => warnings.push(message),
  });
  await localService();
});

/**
 * This test's local file service, `gugu.files` over it, and the working copy's change stream feeding it — as main feeds
 * it from workspace-factory's `watchChanges`.
 */
async function localService() {
  feed?.unsubscribe();
  service = createLocalFileService({ warn: (message) => warnings.push(message) });
  heard = [];
  const started = runtime.watchChanges(root, (update) => {
    heard.push(update);
    service.heard(update);
  });
  if (!started.success) throw new Error(`no change stream: ${JSON.stringify(started.error)}`);
  feed = started.data;
  const ready = await started.data.ready();
  if (!ready.success) throw new Error(`change stream not ready: ${JSON.stringify(ready.error)}`);
  files = createLocalAppFiles({
    service,
    sync: {
      pageFor: (id) => relay.page(id)!,
      grant: (page, grant) => relay.grant(page, grant),
      ungrant: (id, docName) => relay.ungrant(id, docName),
      revoke: (id, reason, which) => relay.revoke(id, reason, which),
    },
    hasCapability: () => true,
    self: async () => ({ userId: 'user:00000000-0000-4000-8000-000000000001', name: '主人' }),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const page of pages.splice(0)) page.gone();
  await service.closeAll();
  feed?.unsubscribe();
  feed = null;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await runtime.dispose();
  await watcher.dispose();
});

let nextId = 1;

describe('gugu.files on a working copy', () => {
  it('two tabs on one file stay in step character by character, and the disk gets it', async () => {
    write('notes.md', '# 标题\n正文\n');
    const [a, b] = [new Page(nextId++, 'notes.md'), new Page(nextId++, 'notes.md')];
    const fa = await a.open();
    const fb = await b.open();
    expect(fa.opened.docName).toBe(fb.opened.docName);
    expect(fa.opened.entry).toMatchObject({ id: 'notes.md', name: 'notes.md', contentType: 'text/markdown', type: 'text' });
    expect(fa.text().toString()).toBe('# 标题\n正文\n');
    for (const ch of 'abc') {
      fa.text().insert(fa.text().length, ch);
      fb.text().insert(0, ch.toUpperCase());
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await until(() => fa.text().toString() === fb.text().toString() && fa.text().toString().length >= '# 标题\n正文\n'.length + 6);
    expect(fa.text().toString()).toBe('CBA# 标题\n正文\nabc');
    // Written within the debounce (1 s, at most 5 s), atomically: no temporary file left behind.
    await until(() => read('notes.md') === 'CBA# 标题\n正文\nabc');
    expect(fs.readdirSync(root)).toEqual(['notes.md']);
    // The stamp is the account's, as in a group (F9): `self` over stateless.
    expect(fa.stateless.map((s) => JSON.parse(s))).toContainEqual({ t: 'self', user: expect.objectContaining({ id: '00000000-0000-4000-8000-000000000001', name: '主人' }) });
  });

  it('an edit on the disk (the agent’s Edit tool) shows up in the pages live, merged with what they are typing', async () => {
    write('plan.md', 'one\ntwo\nthree\n');
    const a = new Page(nextId++, 'plan.md');
    const fa = await a.open();
    // The page types at the end — not written yet — while the agent replaces a line on the disk.
    fa.text().insert(fa.text().length, 'four\n');
    write('plan.md', 'one\nTWO\nthree\n');
    await until(() => fa.text().toString().includes('TWO'));
    expect(fa.text().toString()).toBe('one\nTWO\nthree\nfour\n');
    await until(() => read('plan.md') !== 'one\nTWO\nthree\n');
    expect(read('plan.md')).toBe('one\nTWO\nthree\nfour\n');
  });

  it('a write from outside is never written over: merged first, whatever the page had not saved yet', async () => {
    write('list.md', 'a\nb\n');
    const a = new Page(nextId++, 'list.md');
    const fa = await a.open();
    fa.text().insert(0, 'page\n');
    // Before the page's change is written, someone else rewrites the file (and the watch has not said so yet).
    write('list.md', 'a\nb\noutside\n');
    await until(() => read('list.md') !== 'a\nb\noutside\n');
    expect(read('list.md')).toBe('page\na\nb\noutside\n');
    await until(() => fa.text().toString().includes('outside'));
    expect(fa.text().toString()).toBe('page\na\nb\noutside\n');
  });

  it('a JSON file changed in one key is written back with that one line changed — layout, inline arrays, key order stay (F97)', async () => {
    const original = '{\n  "name": "demo",\n  "version": "1.0.0",\n  "files": ["dist", "README.md"],\n  "scripts": {\n    "build": "tsc"\n  }\n}\n';
    write('package.json', original);
    const a = new Page(nextId++, null);
    const fj = await a.open('package.json');
    fj.doc.transact(() => fj.root().set('version', '1.0.1'));
    await until(() => read('package.json') !== original);
    const before = original.split('\n');
    const after = read('package.json').split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual(['  "version": "1.0.1",']);
  });

  it('line endings, BOM and JSON indentation are kept; JSON merges by keys; a {"$text"} mark opens as live text', async () => {
    write('crlf.md', '﻿x\r\ny\r\n');
    const a = new Page(nextId++, null);
    const fc = await a.open('crlf.md');
    expect(fc.text().toString()).toBe('x\ny\n');
    fc.text().insert(2, 'z\n');
    await until(() => !fs.readFileSync(path.join(root, 'crlf.md')).equals(Buffer.from('﻿x\r\ny\r\n')));
    expect(fs.readFileSync(path.join(root, 'crlf.md'))).toEqual(Buffer.from('﻿x\r\nz\r\ny\r\n'));

    write('board.vote.json', '{\n    "title": {"$text": "周会"},\n    "votes": {}\n}\n');
    const fj = await a.open('board.vote.json');
    expect(fj.opened.entry.type).toBe('json');
    expect(fj.root().get('title')).toBeInstanceOf(Y.Text);
    fj.doc.transact(() => (fj.root().get('votes') as Y.Map<unknown>).set('me', 1));
    // Written with its own indentation and final newline; the mark is gone from the disk, the text stays live.
    await until(() => read('board.vote.json') === '{\n    "title": "周会",\n    "votes": {\n        "me": 1\n    }\n}\n');
    // The agent adds a key on the disk; the page's map keeps what it has and gains that.
    write('board.vote.json', '{\n    "title": "周会",\n    "votes": {\n        "me": 1,\n        "agent": 2\n    }\n}\n');
    await until(() => (fj.root().get('votes') as Y.Map<unknown>).has('agent'));
    expect((fj.root().get('votes') as Y.Map<unknown>).get('agent')).toBe(2);
    expect(fj.root().get('title')).toBeInstanceOf(Y.Text);
  });

  it('a new path through `..` or a link out of the working copy is refused before any folder is made (L11 R22)', async () => {
    write('mine.md', 'x');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-outside-'));
    fs.symlinkSync(outside, path.join(root, 'out'));
    const sibling = `r22-${path.basename(root)}`;
    const a = new Page(nextId++, null);
    expect(() => files.create(a.surface, { name: `../${sibling}/x.md`, content: '' })).toThrow();
    expect(() => files.create(a.surface, { name: 'out/made/x.md', content: '' })).toThrow();
    expect(() => files.rename(a.surface, { ref: { session: SESSION, id: 'mine.md' }, name: 'out/moved/mine.md' })).toThrow();
    expect([fs.existsSync(path.join(root, '..', sibling)), fs.readdirSync(outside)]).toEqual([false, []]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a file is known by its own suffix, a name the type table does not know too (复核 101 K1): main.ts is .ts, not .txt', () => {
    mkdirs('src');
    write('src/main.ts', 'x');
    write('ci.yaml', 'y');
    write('notes.md', 'z');
    const suffixes = Object.fromEntries(files.list({ pageId: 0, extensionId: 'ext', place: { session: SESSION }, workspaceRoot: root, filePath: 'notes.md' }).map((entry) => [entry.name, entry.suffix]));
    expect(suffixes).toEqual({ 'main.ts': '.ts', 'ci.yaml': '.yaml', 'notes.md': '.md' });
  });

  it("a project's folder (L1): the same files and gates, each entry naming the project it is in — never a session", () => {
    write('plan.md', 'x');
    const entry = files.list({ pageId: 0, extensionId: 'ext', place: { project: 'p-1' }, workspaceRoot: root, filePath: null }).find((one) => one.name === 'plan.md');
    expect(entry).toMatchObject({ id: 'plan.md', project: 'p-1' });
    expect(entry).not.toHaveProperty('session');
  });

  it('what the host handed the page needs nothing; other files need files:read / write; nothing outside the working copy', async () => {
    write('mine.md', 'x');
    write('other.md', 'y');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 's');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
    const granted = new Set<string>();
    const gated = createLocalAppFiles({
      service,
      sync: {
        pageFor: (id) => relay.page(id)!,
        grant: (page, grant) => relay.grant(page, grant),
        ungrant: (id, docName) => relay.ungrant(id, docName),
        revoke: (id, reason, which) => relay.revoke(id, reason, which),
      },
      hasCapability: (_id, capability) => granted.has(capability),
      self: async () => ({ userId: 'user:x', name: 'x' }),
    });
    const a = new Page(nextId++, 'mine.md');
    expect((await gated.open(a.surface, { ref: { session: SESSION, id: 'mine.md' } })).access).toBe('rw');
    await expect(gated.open(a.surface, { ref: { session: SESSION, id: 'other.md' } })).rejects.toMatchObject({ code: 'denied' });
    granted.add('files:read');
    expect((await gated.open(a.surface, { ref: { session: SESSION, id: 'other.md' } })).access).toBe('ro');
    granted.add('files:write');
    expect((await gated.open(a.surface, { ref: { session: SESSION, id: 'other.md' } })).access).toBe('rw');
    await expect(gated.open(a.surface, { ref: { session: SESSION, id: 'link.md' } })).rejects.toMatchObject({ code: 'not-found' });
    await expect(gated.open(a.surface, { ref: { session: SESSION, id: '../x.md' } })).rejects.toMatchObject({ code: 'not-found' });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a stored file (an image) opens read-only, as its bytes, under the same gate; nothing is synced for it (owner 10-07)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    write('shot.png', png);
    write('mine.md', 'x');
    const granted = new Set<string>();
    const grants: unknown[] = [];
    const gated = createLocalAppFiles({
      service,
      sync: {
        pageFor: (id) => relay.page(id)!,
        grant: (page, grant) => (grants.push(grant), relay.grant(page, grant)),
        ungrant: (id, docName) => relay.ungrant(id, docName),
        revoke: (id, reason, which) => relay.revoke(id, reason, which),
      },
      hasCapability: (_id, capability) => granted.has(capability),
      self: async () => ({ userId: 'user:x', name: 'x' }),
    });
    const ref = { session: SESSION, id: 'shot.png' };
    await expect(gated.open(new Page(nextId++, 'mine.md').surface, { ref })).rejects.toMatchObject({ code: 'denied' });
    granted.add('files:write');
    const opened = await gated.open(new Page(nextId++, 'mine.md').surface, { ref });
    expect(opened).toMatchObject({ docName: '', access: 'ro', entry: { name: 'shot.png', type: 'binary', contentType: 'image/png' } });
    expect(Buffer.from(opened.bytes!)).toEqual(png);
    granted.clear();
    expect((await gated.open(new Page(nextId++, 'shot.png').surface, { ref })).access).toBe('ro');
    expect(grants).toEqual([]);
  });

  it('the gate comes before a byte is read (复核 81 ①): a page that may not open the file never reads it', async () => {
    // An unreadable file tells the order apart: refused first is `denied`; read first would be the read's own error.
    write('locked.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('mine.md', 'x');
    fs.chmodSync(path.join(root, 'locked.png'), 0o000);
    const granted = new Set<string>();
    const gated = createLocalAppFiles({
      service,
      sync: { pageFor: (id) => relay.page(id)!, grant: () => undefined, ungrant: () => undefined, revoke: () => undefined },
      hasCapability: (_id, capability) => granted.has(capability),
      self: async () => ({ userId: 'user:x', name: 'x' }),
    });
    const ref = { session: SESSION, id: 'locked.png' };
    try {
      await expect(gated.open(new Page(nextId++, 'mine.md').surface, { ref })).rejects.toMatchObject({ code: 'denied' });
      // Control: with files:read the gate lets it through, and the read is what fails.
      granted.add('files:read');
      await expect(gated.open(new Page(nextId++, 'mine.md').surface, { ref })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(path.join(root, 'locked.png'), 0o644);
    }
  });

  it('a document that became binary on the disk is not reopened as bytes (复核 81 ②): reopen says invalid', async () => {
    write('note.md', 'v1');
    const a = new Page(nextId++, 'note.md');
    await a.open();
    write('note.md', Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await expect(files.reopen(a.surface, { ref: { session: SESSION, id: 'note.md' } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('closed and opened again: built from the disk under a new generation; an old one is told stale-epoch', async () => {
    write('gen.md', 'v1');
    const a = new Page(nextId++, 'gen.md');
    const first = await a.open();
    first.text().insert(2, '+');
    // As the runtime closes a file: its changes confirmed, its provider's Close sent, then `files.close`.
    await until(() => !first.provider.hasUnsyncedChanges);
    first.provider.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    files.close(a.surface, { docName: first.opened.docName });
    await until(() => read('gen.md') !== 'v1');
    expect(read('gen.md')).toBe('v1+');
    await until(() => service.hocuspocus.documents.size === 0);
    const second = await a.open();
    expect(second.opened.docName).not.toBe(first.opened.docName);
    expect(second.text().toString()).toBe('v1+');
    const [, gen] = second.opened.docName.split('@');
    expect(Number(gen)).toBe(Number(first.opened.docName.split('@')[1]) + 1);
    // A page still on the old generation (granted it, never reopened) is refused with the new one, and reopens.
    relay.grant(a.sync, { docName: first.opened.docName, itemId: 'gen.md', access: 'rw', needs: null });
    const stale = new HocuspocusProvider({ websocketProvider: a.ws, name: first.opened.docName, document: new Y.Doc(), token: '', sessionAwareness: true });
    const refused = new Promise<string>((resolve) => stale.on('authenticationFailed', ({ reason }: { reason: string }) => resolve(reason)));
    stale.attach();
    expect(await refused).toBe(`stale-epoch:${gen}`);
    stale.destroy();
  });

  it('deleted on the disk: the pages hear `deleted` and the grant goes', async () => {
    write('bye.md', 'x');
    const a = new Page(nextId++, 'bye.md');
    const fa = await a.open();
    rm('bye.md');
    await until(() => a.told.some((m) => m.t === 'revoked' && m.reason === 'deleted'));
    expect(fa.closed).toContain('deleted');
    expect(relay.page(a.id)?.grants.size).toBe(0);
  });

  // 摩擦单 F92 (S23): after `rm TODO.md` and `git checkout -- TODO.md` the built-in editor was back, the App page gone for good.
  it('deleted and put back on the disk (git checkout -- f): the page hears `back`, reopens it under the next generation, and it is live', async () => {
    write('todo.md', '- a\n- b\n');
    const a = new Page(nextId++, 'todo.md');
    const fa = await a.open();
    const went = fa.opened.docName;
    rm('todo.md');
    await until(() => a.told.some((m) => m.t === 'revoked' && m.reason === 'deleted'));
    // Put back as git does it: a new file at that path, with what the branch holds.
    write('todo.md', '- a\n- b\n- c\n');
    // Control (a888c82a6): nothing more is ever said to the page.
    await until(() => a.told.some((m) => m.t === 'back' && m.docName === went));
    const again = await a.reopen('todo.md');
    expect(Number(again.opened.docName.split('@')[1])).toBe(Number(went.split('@')[1]) + 1);
    expect(again.text().toString()).toBe('- a\n- b\n- c\n');
    again.text().insert(again.text().length, '- d\n');
    await until(() => read('todo.md') !== '- a\n- b\n- c\n');
    expect(read('todo.md')).toBe('- a\n- b\n- c\n- d\n');
    expect(a.told.filter((m) => m.t === 'back')).toHaveLength(1);
  });

  it('its folder taken too and brought back (a branch switch): still heard, from the nearest folder that is there', async () => {
    mkdirs('docs/plans');
    write('docs/plans/q4.md', 'v1');
    const a = new Page(nextId++, 'docs/plans/q4.md');
    const fa = await a.open();
    rm('docs');
    await until(() => a.told.some((m) => m.t === 'revoked' && m.reason === 'deleted'));
    mkdirs('docs/plans');
    write('docs/plans/q4.md', 'v2');
    await until(() => a.told.some((m) => m.t === 'back' && m.docName === fa.opened.docName));
    expect((await a.reopen('docs/plans/q4.md')).text().toString()).toBe('v2');
  });

  it('its folder taken, as Linux reports it (the one name its watched parent saw, nothing for the file): still heard', async () => {
    // Only the working copy's own folder is watched: inotify there says one name, `rename docs`, for the folder made
    // with what is in it and again for it taken (read on Linux, 10-17); nothing ever names the file.
    const docs = path.join(root, 'docs');
    fs.mkdirSync(path.join(docs, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'plans', 'q4.md'), 'v1');
    reported([{ kind: 'create', path: docs }]);
    const a = new Page(nextId++, 'docs/plans/q4.md');
    await a.open();
    fs.rmSync(docs, { recursive: true });
    reported([{ kind: 'delete', path: docs }]);
    await until(() => a.told.some((m) => m.t === 'revoked' && m.reason === 'deleted'));
  });

  it('the service’s own write, echoed back by the OS, changes nothing: the document and the disk stay as they are', async () => {
    write('echo.md', 'one\n');
    const abs = path.join(root, 'echo.md');
    const a = new Page(nextId++, 'echo.md');
    const fa = await a.open();
    fa.text().insert(fa.text().length, 'two\n');
    await until(() => read('echo.md') !== 'one\n');
    expect(read('echo.md')).toBe('one\ntwo\n');
    const doc = service.hocuspocus.documents.get(fa.opened.docName)!;
    const before = { state: Y.encodeStateVector(doc), bytes: fs.readFileSync(abs), mtime: fs.statSync(abs).mtimeMs };
    // What fseventsd sends for a write beside it renamed over it (mac1, 10-17): the folder, the temporary file
    // (71936, gone → `delete`), the file (67584, there → `create`).
    const from = heard.length;
    reported([
      { kind: 'create', path: root },
      { kind: 'delete', path: path.join(root, '.echo.md.0a1b2c3d.gugu-tmp') },
      { kind: 'create', path: abs },
    ]);
    await until(() => heard.slice(from).some((update) => update.kind === 'changes' && update.changes.some((change) => change.path === abs)));
    expect(Y.encodeStateVector(doc)).toEqual(before.state);
    expect(doc.getText('content').toString()).toBe('one\ntwo\n');
    expect([fs.readFileSync(abs), fs.statSync(abs).mtimeMs]).toEqual([before.bytes, before.mtime]);
  });

  it('closed before it came back: that page is not waited for, and hears nothing', async () => {
    write('gone.md', 'x');
    const [a, c] = [new Page(nextId++, 'gone.md'), new Page(nextId++, 'gone.md')];
    const fa = await a.open();
    await c.open();
    rm('gone.md');
    await until(() => [a, c].every((page) => page.told.some((m) => m.t === 'revoked' && m.reason === 'deleted')));
    // A closes it as the runtime does (`files.close` with the open file it held); C still holds it.
    files.close(a.surface, { docName: fa.opened.docName });
    write('gone.md', 'y');
    // One watch tells every page still waiting, at the same moment: once C has heard, A would have too.
    await until(() => c.told.some((m) => m.t === 'back'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.told.some((m) => m.t === 'back')).toBe(false);
  });
});

/** An unsigned token is enough: the relay only reads `sub` / `exp` from it. */
function jwt(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

/** A stand-in file service: opens at once, keeps what it is sent, notes how it was closed. */
function fakeFileService() {
  const state = { frames: [] as Uint8Array[], closed: null as { code: number; reason: string } | null };
  remote.connect = (_url, _protocols, events) => {
    queueMicrotask(() => events.open());
    return {
      send: (frame) => state.frames.push(frame),
      close: (code, reason) => {
        state.closed = { code, reason };
      },
      ping: () => false,
      terminate: () => undefined,
    };
  };
  return state;
}

/** A page speaking raw frames to the relay (no provider): for a group file the test only routes. */
function rawPage(id: number) {
  const told: SyncToPage[] = [];
  const sync = relay.attachPage(id, 'ext', {
    post: (message) => {
      if (!(message instanceof ArrayBuffer)) told.push(message);
    },
    close: () => undefined,
  });
  return { sync, told };
}

describe('the relay with a working copy', () => {
  it('switching accounts takes back group files only: a working copy keeps its grant, its connection and its syncing', async () => {
    // The account check runs every 60 s; only that clock is ours.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fileService = fakeFileService();
    remote.token = jwt('user-a');
    // B holds a group file, on the file service.
    const b = rawPage(nextId++);
    relay.grant(b.sync, { docName: 'item-1@0', itemId: 'item-1', access: 'rw', needs: null });
    relay.fromPage(b.sync, { t: 'hello' });
    await until(() => b.told.some((m) => m.t === 'up'));
    relay.fromPage(b.sync, encodeAuthFrame('item-1@0\0sb', '').slice().buffer);
    expect(fileService.frames).toHaveLength(1);
    // A holds a working-copy file, live.
    write('mine.md', 'v');
    const a = new Page(nextId++, 'mine.md');
    const fa = await a.open();
    const toldBefore = a.told.length;

    remote.token = jwt('user-b');
    vi.advanceTimersByTime(60_000);
    await until(() => b.told.some((m) => m.t === 'revoked'));
    expect(b.told).toContainEqual({ t: 'revoked', docName: 'item-1@0', reason: 'signed-out' });
    expect(relay.page(b.sync.id)?.grants.size).toBe(0);
    expect(fileService.closed).toEqual({ code: 4401, reason: 'signed-out' });
    // A: still granted, told nothing (no revoked, no down), and what it types still reaches the disk.
    expect(relay.page(a.id)?.grants.has(fa.opened.docName)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.told.slice(toldBefore)).toEqual([]);
    fa.text().insert(1, '2');
    await until(() => read('mine.md') !== 'v');
    expect(read('mine.md')).toBe('v2');
    relay.pageGone(b.sync.id);
  });
});

/** A page running the real runtime (`files-entry` → OpenFile), its sync port on the relay, as main wires a page's port. */
async function runtimePage(filePath: string) {
  const id = nextId++;
  const surface: LocalSurface = { pageId: id, extensionId: 'ext', place: { session: SESSION }, workspaceRoot: root, filePath };
  vi.resetModules();
  const { setSyncPortSource } = await import('../../../../../src/session/app-runtime/sync-link');
  const told: SyncToPage[] = [];
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => setTimeout(() => relay.fromPage(sync, message instanceof ArrayBuffer ? message.slice(0) : message), 0),
  };
  const sync = relay.attachPage(id, 'ext', {
    post: (message) =>
      setTimeout(() => {
        if (!(message instanceof ArrayBuffer)) told.push(message as SyncToPage);
        port.onmessage?.({ data: message instanceof ArrayBuffer ? message.slice(0) : message });
      }, 0),
    close: () => undefined,
  });
  setSyncPortSource(async () => port);
  const { openFile } = await import('../../../../../src/session/app-runtime/files-entry');
  const said: string[] = [];
  const host = {
    apiVersion: EXTENSION_API_VERSION,
    reportError: async (message: string) => {
      said.push(message);
    },
    onFilesChanged: () => () => undefined,
    appFiles: {
      open: (args: { ref: { session: string; id: string }; readOnly?: boolean }) => files.open(surface, args),
      reopen: (args: { ref: { session: string; id: string }; readOnly?: boolean }) => files.reopen(surface, args),
      close: async (args: { docName: string }) => files.close(surface, args),
    },
    clipboard: { writeText: async () => undefined },
  };
  const file = (await openFile(host as never, { session: SESSION, id: filePath })) as {
    text: string;
    insert(index: number, text: string): void;
    readonly status: string;
    readonly saved: boolean;
    close(): void;
  };
  return { file, told, said, gone: () => relay.pageGone(id) };
}

describe('a working copy on the real runtime, the relay and the local service (L3, 统筹 10:49)', () => {
  it('moved to a new generation while away (refused as stale): back online, the disk as the page, nothing left pending on the service’s connection', async () => {
    await localService();
    const connections: { incomingMessageQueue: Record<string, unknown[]>; terminated?: boolean }[] = [];
    const handle = service.hocuspocus.handleConnection.bind(service.hocuspocus);
    service.hocuspocus.handleConnection = ((...args: Parameters<typeof handle>) => {
      const connection = handle(...args);
      connections.push(connection as never);
      return connection;
    }) as typeof handle;
    write('notes.md', 'one\n');
    const page = await runtimePage('notes.md');
    const docs = () => [...service.hocuspocus.documents.keys()];
    await until(() => page.file.status === 'online' && docs().length === 1);
    const first = docs()[0]!;

    // Away: the service closes its connections; the document unloads (a new generation), the page's retry is refused as stale.
    await service.closeAll();
    await until(() => page.file.status === 'online' && page.file.saved && docs().length === 1 && docs()[0] !== first);

    page.file.insert(page.file.text.length, 'two\n');
    await until(() => read('notes.md') !== 'one\n');
    expect(read('notes.md')).toBe('one\ntwo\n');
    expect(page.file.text).toBe('one\ntwo\n');

    // One connection, never reset, and nothing waiting on it for a key that will not authenticate again.
    expect(connections).toHaveLength(1);
    expect(connections[0]!.terminated).toBeFalsy();
    expect(Object.keys(connections[0]!.incomingMessageQueue)).toEqual([]);
    expect(page.told.filter((message) => message.t === 'down')).toEqual([]);
    expect(page.said).toEqual([]);
    page.file.close();
    page.gone();
  });
});
