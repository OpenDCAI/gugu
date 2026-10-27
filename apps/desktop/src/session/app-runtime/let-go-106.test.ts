import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeAuthFrame, encodeSyncUpdateFrame, readFrameHead } from '@shared/extensions/app-runtime-protocol';
import { FileSyncRelay, type Grant } from '@shared/extensions/file-sync-core';
import { FakeService, fileOpened, until } from './fake-file-service';

/**
 * 摩擦单 F106: what a program (or a page) wrote reaches the file service before main takes the file back. The real relay
 * (`file-sync-core.ts`) stands between the runtime and the fake file service here, as main does: grants, `denied`, wills.
 *
 * S22 (L5): a tool wrote `f.data.subscribers[agent] = true` and returned; the call ended and main closed the file it had
 * handed on the program's behalf (`revoke … unbound`) — the write, still in the 50 ms batch or on its way, then reached a
 * relay with no grant for it and was dropped. Now the program is told, closes the file itself (its batch first, then its
 * Close) and the call ends after that; a page's own `close` likewise finishes on its own Close.
 */

type JsonFile = { data: Record<string, unknown>; readonly saved: boolean; readonly status: string; close(): void };
type TextFile = { text: string; insert(index: number, text: string): void; readonly saved: boolean; readonly status: string; close(): void };

const USER_TOKEN = (() => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'user-a', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();

afterEach(() => {
  vi.useRealTimers();
});

/** One page (or program: `program`) with the runtime loaded afresh, its sync port on the real relay, the relay on the fake service. */
async function loadOnRelay(type: 'text' | 'json', options: { program?: boolean; readOnly?: boolean } = {}) {
  vi.resetModules();
  const service = new FakeService();
  /** Wills main delivered on its own connection: a write that reached the service on the page's own needs none. */
  const willKeys = new Set<string>();
  /** Every routing key the relay sent the service a frame on. */
  const sentKeys = new Set<string>();
  /** The service out of reach (`down`): the live connection drops and new ones do not open, until `up`. */
  let live: { close(code: number, reason: string): void } | null = null;
  let reachable = true;
  const net = {
    down() {
      reachable = false;
      live?.close(1006, 'unreachable');
    },
    up() {
      reachable = true;
    },
  };
  const relay = new FileSyncRelay({
    serviceUrl: () => 'ws://fake',
    connect: (_url, _protocols, events) => {
      if (!reachable) {
        setTimeout(() => events.close(1006, 'unreachable'), 0);
        return { send: () => undefined, close: () => undefined, ping: () => false, terminate: () => undefined };
      }
      live = events;
      service.toPage = ({ data }) => {
        if (data instanceof ArrayBuffer) events.message(new Uint8Array(data));
      };
      setTimeout(() => events.open(), 0);
      return {
        send: (frame) => {
          const key = readFrameHead(frame)?.key ?? '';
          sentKeys.add(key);
          if (key.includes('\u0000will-')) willKeys.add(key);
          service.fromPage(frame.slice().buffer);
        },
        close: () => undefined,
        ping: () => false,
        terminate: () => undefined,
      };
    },
    token: async () => USER_TOKEN,
    hasCapability: () => true,
    warn: () => undefined,
  });
  const PAGE = 7;
  /** What main tells the page; `deaf` stands for a runtime that never acts on it. */
  const told: { t?: string; reason?: string }[] = [];
  const control = { deaf: false };
  // A MessagePort delivers later, and a copy — both ways.
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) =>
      setTimeout(() => relay.fromPage(page, message instanceof ArrayBuffer ? message.slice(0) : message), 0),
  };
  const page = relay.attachPage(PAGE, 'ext', {
    post: (message) =>
      setTimeout(() => {
        if (!(message instanceof ArrayBuffer)) {
          told.push(message as { t?: string });
          if (control.deaf && (message as { t?: string }).t === 'revoked') return;
        }
        port.onmessage?.({ data: message instanceof ArrayBuffer ? message.slice(0) : message });
      }, 0),
    close: () => undefined,
  });
  const { setSyncPortSource } = await import('./sync-link');
  setSyncPortSource(async () => port);
  const { openFile } = await import('./files-entry');
  const opened = fileOpened(type);
  if (options.readOnly) opened.access = 'ro';
  const closed: string[] = [];
  const host = {
    apiVersion: EXTENSION_API_VERSION,
    ...(options.program ? { program: true } : {}),
    reportError: vi.fn(async (_message: string) => undefined),
    onFilesChanged: () => () => undefined,
    appFiles: {
      open: vi.fn(async () => {
        relay.grant(page, { docName: opened.docName, itemId: opened.entry.id, access: opened.access, needs: null });
        return structuredClone(opened);
      }),
      // What main's `reopen` does: the file at its epoch now granted, the old epoch retired (`revoke` … null).
      reopen: vi.fn(async () => {
        let docName = opened.docName;
        for (let epoch = service.superseded.get(docName); epoch !== undefined; epoch = service.superseded.get(docName)) {
          docName = `${docName.slice(0, docName.lastIndexOf('@') + 1)}${epoch}`;
        }
        relay.grant(page, { docName, itemId: opened.entry.id, access: opened.access, needs: null });
        relay.revoke(PAGE, null, (grant) => grant.itemId === opened.entry.id && grant.docName !== docName);
        return { ...structuredClone(opened), docName };
      }),
      // What main's `appFiles.close` does.
      close: vi.fn(async ({ docName }: { docName: string }) => {
        closed.push(docName);
        relay.ungrant(PAGE, docName);
      }),
    },
    clipboard: { writeText: async () => undefined },
  };
  const open = <File>() => openFile(host as never, host.appFiles.open()) as Promise<File>;
  const handed = (grant: Grant) => grant.itemId === opened.entry.id && grant.needs === null;
  return { service, relay, open, closed, willKeys, sentKeys, told, control, handed, PAGE, page, net, host };
}

describe('a write reaches the file service before main takes the file back (摩擦单 F106)', () => {
  it('a write refused by a read-only grant ends the replica without leaving a will to retry', async () => {
    const { service, relay, open, host, page, PAGE } = await loadOnRelay('json');
    const file = await open<JsonFile>();
    await until(() => file.saved);
    page.grants.get('item-1@1')!.access = 'ro';
    file.data.refused = true;
    await until(() => file.status === 'gone');
    file.close();
    await until(() => page.grants.size === 0);
    expect(host.reportError).toHaveBeenCalledTimes(1);
    expect(host.reportError).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    expect(service.docOf('item-1@1').getMap('root').toJSON()).toEqual({});
    expect(page.wills.size).toBe(0);
    relay.pageGone(PAGE);
  });

  it.each(['text', 'json'] as const)('a read-only %s replica with deletion history finishes syncing and keeps receiving changes', async (type) => {
    const { service, relay, open, host, told, PAGE } = await loadOnRelay(type, { readOnly: true });
    const doc = service.docOf('item-1@1');
    if (type === 'json') {
      doc.getMap('root').set('status', 'old');
      doc.getMap('root').set('status', 'current');
    } else {
      doc.getText('content').insert(0, 'old');
      doc.getText('content').delete(0, 3);
      doc.getText('content').insert(0, 'current');
    }
    const file = await open<JsonFile | TextFile>();
    await until(() => file.saved);
    expect(file.status).toBe('online');
    if ('data' in file) {
      expect(file.data.status).toBe('current');
      doc.getMap('root').set('status', 'next');
      await until(() => file.data.status === 'next');
    } else {
      expect(file.text).toBe('current');
      service.write('item-1@1', ' next');
      await until(() => file.text === 'current next');
    }
    expect(told.filter((message) => message.t === 'denied')).toEqual([]);
    expect(host.reportError).not.toHaveBeenCalled();
    file.close();
    relay.pageGone(PAGE);
  });

  it('a program writes twice and returns at once; the call ends: both writes are at the service by then', async () => {
    const { service, relay, open, willKeys, handed, PAGE, page } = await loadOnRelay('json', { program: true });
    service.docOf('item-1@1').getMap('root').set('subscribers', new Y.Map());
    const file = await open<JsonFile>();
    const data = file.data as { subscribers: Record<string, boolean>; count?: number };
    data.count = 1;
    data.subscribers.agentA = true;
    // The call ends as main ends it (`extension-program-surface.ts`): the program is told, and closes the file itself.
    await relay.revoke(PAGE, 'unbound', handed);
    expect(service.docOf('item-1@1').getMap('root').toJSON()).toEqual({ count: 1, subscribers: { agentA: true } });
    // On its own connection, no will needed; and the file is no longer the program's.
    expect([...willKeys]).toEqual([]);
    expect(page.grants.size).toBe(0);
    expect(file.status).toBe('gone');
  });

  it('a program that never lets go: at the bound main closes the file for it, and it writes nothing after', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, relay, open, told, control, handed, PAGE } = await loadOnRelay('json', { program: true });
    const file = await open<JsonFile>();
    await vi.advanceTimersByTimeAsync(50);
    control.deaf = true;
    let ended = false;
    void relay.revoke(PAGE, 'unbound', handed).then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended, 'closed for it at the bound').toBe(true);
    // Its connection is gone: what it writes now is refused, and never reaches the service.
    file.data.late = 1;
    await vi.advanceTimersByTimeAsync(200);
    expect(service.docOf('item-1@1').getMap('root').toJSON()).toEqual({});
    expect(told.filter((message) => message.t === 'denied').length).toBeGreaterThan(0);
  });

  it('a program cut off from the service writes twice, the call ends, and it cannot close: what it wrote reaches the service once it is back (L3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, relay, open, handed, PAGE, net } = await loadOnRelay('json', { program: true });
    const file = await open<JsonFile>();
    await vi.advanceTimersByTimeAsync(50);
    net.down();
    await vi.advanceTimersByTimeAsync(200);
    file.data.a = 1;
    file.data.b = 2;
    // Offline: a will holds them (main has it).
    await vi.advanceTimersByTimeAsync(1_000);
    void relay.revoke(PAGE, 'unbound', handed);
    await vi.advanceTimersByTimeAsync(6_000);
    net.up();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.docOf('item-1@1').getMap('root').toJSON()).toEqual({ a: 1, b: 2 });
  });

  it('while it is being let go of, no new connection opens on it — only the ones the program has may finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { relay, open, told, control, handed, PAGE, page } = await loadOnRelay('json', { program: true });
    await open<JsonFile>();
    await vi.advanceTimersByTimeAsync(50);
    control.deaf = true;
    void relay.revoke(PAGE, 'unbound', handed);
    relay.fromPage(page, encodeAuthFrame('item-1@1\u0000another', '').slice().buffer);
    await vi.advanceTimersByTimeAsync(50);
    expect(told).toContainEqual({ t: 'denied', key: 'item-1@1\u0000another', reason: 'not-granted' });
    await vi.advanceTimersByTimeAsync(6_000);
  });

  it('granted the same file again before its Close is back: the call ends then, and the new open file outlives the bound (L4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, relay, open, told, handed, PAGE, page } = await loadOnRelay('json', { program: true });
    const first = await open<JsonFile>();
    await vi.advanceTimersByTimeAsync(50);
    let ended = false;
    void relay.revoke(PAGE, 'unbound', handed).then(() => (ended = true));
    // The next call hands it again at once (or a resident page is retargeted back to it): main's grant is there before
    // the program's Close for the last one.
    relay.grant(page, { docName: 'item-1@1', itemId: 'item-1', access: 'rw', needs: null });
    await vi.advanceTimersByTimeAsync(200);
    expect(first.status).toBe('gone');
    expect(ended, 'the last call is not held to the bound').toBe(true);
    const second = await open<JsonFile>();
    await vi.advanceTimersByTimeAsync(6_000);
    second.data.after = 1;
    await vi.advanceTimersByTimeAsync(200);
    expect(told.filter((message) => message.t === 'denied')).toEqual([]);
    expect(second.status).toBe('online');
    expect(service.docOf('item-1@1').getMap('root').get('after')).toBe(1);
  });

  it('opened again while the first is still coming back, and the first let go of: the second writes (L4 C1, 摩擦单 F115)', async () => {
    const { service, open, told, host } = await loadOnRelay('json');
    const opening = open<JsonFile>();
    // The workspace App's context arrives twice: a second open goes out while the first is still connecting. Main grants
    // it at once; its answer reaches the page only after the page let go of the first (a stale open, closed).
    const openInMain = host.appFiles.open.getMockImplementation()!;
    let answer: (() => void) | null = null;
    host.appFiles.open.mockImplementationOnce(async () => {
      const opened = await openInMain();
      await new Promise<void>((resolve) => (answer = resolve));
      return opened;
    });
    const second = open<JsonFile>();
    const first = await opening;
    await until(() => answer !== null);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    answer!();
    const file = await second;
    file.data.after = 1;
    await until(() => service.docOf('item-1@1').getMap('root').get('after') === 1 || told.some((message) => message.t === 'denied'));
    // Control (today): the first's close let go of the grant the second was answered with — `denied not-granted`.
    expect(told.filter((message) => message.t === 'denied')).toEqual([]);
    expect(file.status).toBe('online');
  });

  it('the open it waited for fails: the file let go of closes then — a failed answer is an answer (F115)', async () => {
    const { open, closed, host } = await loadOnRelay('json');
    const first = await open<JsonFile>();
    let refuse: (() => void) | null = null;
    host.appFiles.open.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = () => reject(new Error('not-found')))));
    const second = open<JsonFile>().catch((error: unknown) => error);
    await until(() => refuse !== null);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed, 'waiting for that answer').toEqual([]);
    refuse!();
    expect(await second).toBeInstanceOf(Error);
    await until(() => closed.length === 1);
    expect(closed).toEqual(['item-1@1']);
  });

  it('taken back for good (removed from the group): cut at once — what comes after is not forwarded (真源原则 9)', async () => {
    const { service, relay, open, handed, PAGE } = await loadOnRelay('json', { program: true });
    const file = await open<JsonFile>();
    await until(() => file.saved);
    file.data.a = 1;
    file.data.b = 2; // right after: still on its way when the grant goes
    await relay.revoke(PAGE, 'removed-from-group', handed);
    await until(() => file.status === 'gone');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.docOf('item-1@1').getMap('root').get('b')).toBeUndefined();
  });

  it('refused as stale on a reconnect, then main retires the old epoch: no Close of main’s waits at the service on the refused key', async () => {
    const { service, open } = await loadOnRelay('text');
    const file = await open<TextFile>();
    file.insert(0, 'kept');
    await until(() => file.saved && service.text('item-1@1') === 'kept');
    // Away a moment (rate-limited), compacted meanwhile: its next Auth at @1 is refused, and the reopen retires @1.
    service.closeDocument('item-1@1', 'rate-limited');
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await until(() => file.status === 'online' && file.saved && service.keysOf('item-1@2').length === 1, 8000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A Hocuspocus 4.7 keeps it for an Auth that never comes (on a real one: L2's local-files cell, #6847).
    expect([...service.queued.keys()]).toEqual([]);
  });

  it('a key the page does not hold opens with its Auth: a frame left over from a connection that is gone goes nowhere', async () => {
    const { relay, open, page, sentKeys } = await loadOnRelay('text');
    await open<TextFile>();
    const key = 'item-1@1\u0000left-over';
    // Sent before the page heard its connection was refused (a real service can answer that before these arrive).
    relay.fromPage(page, encodeSyncUpdateFrame(key, Y.encodeStateAsUpdate(new Y.Doc())).slice().buffer);
    expect(sentKeys.has(key)).toBe(false);
    relay.fromPage(page, encodeAuthFrame(key, '').slice().buffer);
    expect(sentKeys.has(key)).toBe(true);
  });

  it('a page writes and closes the file at once: its last letters land, and no saved state is sent again', async () => {
    const { service, open, closed, willKeys, page } = await loadOnRelay('text');
    const file = await open<TextFile>();
    file.insert(0, 'a');
    file.insert(1, 'b');
    file.close();
    await until(() => closed.length === 1 && page.grants.size === 0);
    expect(service.text('item-1@1')).toBe('ab');
    expect([...willKeys]).toEqual([]);
  });
});
