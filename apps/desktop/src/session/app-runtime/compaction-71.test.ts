import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPage, until, type FakeService } from './fake-file-service';

/**
 * 摩擦单 F71, the page's half: the file service compacts a file while it is open (gugu-supabase files-core, #77). The
 * page drains — sends what is batched, pauses, answers `drained` once all it sent is confirmed — and after the swap
 * reopens at the new epoch and replays what it wrote meanwhile, measured from a shadow that took only others' changes.
 * The service here speaks the same stateless words (`compact`, `drained`, `resume`, `compacted:<n>`).
 */

type TextFile = {
  text: string;
  insert(index: number, text: string): void;
  readonly saved: boolean;
  readonly status: string;
  onChange(handler: (event: { local: boolean }) => void): () => void;
  onStatus(handler: (status: string) => void): () => void;
  close(): void;
};
type TextField = { text: string; insert(index: number, text: string): void };
type JsonFile = {
  data: Record<string, unknown>;
  readonly saved: boolean;
  readonly status: string;
  onChange(handler: (event: { local: boolean }) => void): () => void;
  onStatus(handler: (status: string) => void): () => void;
  textAt(path: (string | number)[]): TextField;
  presence: { set(state: unknown): void };
  close(): void;
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const drainedFrom = (service: FakeService, since = 0) =>
  service.stateless.slice(since).filter((m) => (JSON.parse(m.payload) as { t?: string }).t === 'drained').length;

afterEach(() => {
  vi.useRealTimers();
});

/** On fake timers: advances them a step at a time until `check` holds, or fails after `ms` of them. */
async function untilAdvancing(check: () => boolean, ms: number): Promise<void> {
  for (let spent = 0; !check(); spent += 250) {
    if (spent > ms) throw new Error(`not within ${ms} ms of timers: ${check.toString()}`);
    await vi.advanceTimersByTimeAsync(250);
  }
}

/**
 * A types marks into the file; B (someone else, at the service) writes too. Twice, the service is slow to confirm for a
 * moment — A's confirmed base goes stale while it and B keep writing — and then compacts the file.
 */
async function typingThroughTwoCompactions(drain: boolean) {
  const { service, open, host } = await loadPage<TextFile>('text');
  const file = await open();
  let doc = 'item-1@1';
  const mine: string[] = [];
  const theirs: string[] = [];
  let typing = true;
  let othersWait = false;
  const a = (async () => {
    for (let i = 0; typing; i += 1) {
      const mark = `‹A${i}›`;
      mine.push(mark);
      file.insert(file.text.length, mark);
      await settle(30);
    }
  })();
  const b = (async () => {
    for (let j = 0; typing; j += 1) {
      // B's own page drains as A's does; B writes at the service here, so it simply waits out the swap.
      if (!othersWait) {
        const mark = `‹B${j}›`;
        theirs.push(mark);
        service.insertAt(doc, 0, mark);
      }
      await settle(70);
    }
  })();
  for (const next of ['item-1@2', 'item-1@3']) {
    await settle(200);
    service.holdAcks = true;
    await settle(150);
    othersWait = true;
    if (drain) service.releaseAcks();
    expect(await service.compact(doc, next, { drain })).toBe(true);
    service.releaseAcks();
    doc = next;
    othersWait = false;
  }
  await settle(200);
  typing = false;
  await Promise.all([a, b]);
  await until(() => file.saved && service.text(doc) === file.text, 5000).catch(() => undefined);
  const said = (host.reportError.mock.calls as unknown as [string][]).map(([message]) => message);
  return { text: service.text(doc), page: file.text, mine, theirs, said, reopens: host.appFiles.reopen.mock.calls.length };
}

describe('a file compacted while it is open (摩擦单 F71, the page)', () => {
  it('typing through two compactions: every mark exactly once, on both sides alike', async () => {
    const run = await typingThroughTwoCompactions(true);
    expect(run.reopens).toBe(2);
    expect(run.page).toBe(run.text);
    for (const mark of [...run.mine, ...run.theirs]) expect(count(run.text, mark), mark).toBe(1);
    expect(run.said.filter((message) => message.includes('could not be replayed'))).toEqual([]);
  });

  it('control: the old way — closed without draining, replayed from what was last confirmed — marks doubled or lost', async () => {
    const run = await typingThroughTwoCompactions(false);
    const wrong = [...run.mine, ...run.theirs].filter((mark) => count(run.text, mark) !== 1);
    const unreplayed = run.said.filter((message) => message.includes('could not be replayed'));
    expect(wrong.length + unreplayed.length).toBeGreaterThan(0);
  });

  it('given up (`resume`): what the page kept while paused goes out, nothing lost, still the same epoch', async () => {
    const { service, open, host } = await loadPage<TextFile>('text');
    const file = await open();
    // Sent, not yet confirmed, when the compaction begins.
    service.holdAcks = true;
    file.insert(0, 'kept ');
    await until(() => service.text('item-1@1') === 'kept ');
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await settle(50);
    expect(drainedFrom(service, since)).toBe(0);
    // Written while paused: kept on the page, and it does not stop it from draining once the rest is confirmed (L3 #1:
    // the provider counts that batch as unconfirmed the moment it starts).
    file.insert(file.text.length, 'while paused');
    service.releaseAcks();
    await until(() => drainedFrom(service, since) === 1);
    await settle(120);
    expect(service.text('item-1@1')).toBe('kept ');
    expect(file.status).toBe('online');
    service.say('item-1@1', { t: 'resume' });
    await until(() => file.saved && service.text('item-1@1') === 'kept while paused');
    expect(host.appFiles.reopen).not.toHaveBeenCalled();
  });

  it('composing (an IME hold): no `drained` until the hold ends — then at once, with no timer (L3 #2, #4)', async () => {
    const { service, open, internals } = await loadPage<TextFile>('text');
    const file = await open();
    // Synced and confirmed first: a hold taken earlier would hold the sync itself, and nothing would drain anyway.
    await until(() => file.saved);
    const release = internals.get(file)!.internalsForBinding().holdRemote();
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await settle(150);
    expect(drainedFrom(service, since)).toBe(0);
    release();
    await until(() => drainedFrom(service, since) === 1);
  });

  it('what the App sees: status never moves, one change for the one remote write, f.data and textAt carry on, presence back at once', async () => {
    const { service, open } = await loadPage<JsonFile>('json');
    // The service's own writes sort first when a replica is rebuilt from its state (Yjs integrates by client, highest
    // first): its keys then come in another order than on this page — the same data must still read as no change.
    service.docOf('item-1@1').clientID = 2 ** 32 - 1;
    const file = await open();
    file.data.title = 'plan';
    file.data.note = { $text: 'hello' };
    file.presence.set({ at: 1 });
    await until(() => file.saved);
    const data = file.data;
    const note = file.textAt(['note']);
    const statuses: string[] = [];
    file.onStatus((status) => statuses.push(status));
    let changes = 0;
    file.onChange(() => (changes += 1));
    const presence = service.awareness.length;
    // Someone else writes while this page is paused: that is the one change it should hear.
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await until(() => drainedFrom(service, since) === 1);
    service.docOf('item-1@1').getMap('root').set('remote', 1);
    await until(() => file.data.remote === 1);
    file.data.title = 'plan 2'; // this page's own, while paused
    expect(await service.compact('item-1@1', 'item-1@2', { drain: false })).toBe(true);
    await until(() => file.saved && service.docOf('item-1@2').getMap('root').get('title') === 'plan 2');
    // (onStatus also fires when `saved` moves, F20.)
    expect(statuses.filter((status) => status !== 'online')).toEqual([]);
    expect(changes).toBe(2); // the remote write, and this page's own write — nothing for the swap itself
    expect(file.data).toBe(data);
    expect(file.data.title).toBe('plan 2');
    expect(note.text).toBe('hello');
    note.insert(5, ' world');
    await until(() => service.docOf('item-1@2').getMap('root').toJSON().note === 'hello world');
    // Its presence went out on the new connection with the sync, not a window later.
    expect(service.awareness.length).toBeGreaterThan(presence);
  });

  it('paused longer than the stall watch: not a stall — no error, still online (L3 #3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, open, host, STALL_MS } = await loadPage<TextFile>('text');
    const file = await open();
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await vi.advanceTimersByTimeAsync(20);
    expect(drainedFrom(service, since)).toBe(1);
    file.insert(0, 'waiting');
    await vi.advanceTimersByTimeAsync(STALL_MS + 2000);
    const said = (host.reportError.mock.calls as unknown as [string][]).map(([message]) => message);
    expect(said.filter((message) => message.includes('did not answer'))).toEqual([]);
    expect(file.status).toBe('online');
    service.say('item-1@1', { t: 'resume' });
    await vi.advanceTimersByTimeAsync(100);
    expect(service.text('item-1@1')).toBe('waiting');
  });

  it('let go of during the reopen, having written: the swap finishes first — the write reaches the new epoch, a will holds it too (L3 probe I)', async () => {
    const { service, open, host } = await loadPage<TextFile>('text');
    const posted: unknown[] = [];
    const fromPage = service.fromPage.bind(service);
    service.fromPage = (message: unknown) => {
      if (!(message instanceof ArrayBuffer)) posted.push(message);
      fromPage(message);
    };
    const file = await open();
    const reopen = host.appFiles.reopen.getMockImplementation()!;
    host.appFiles.reopen.mockImplementationOnce(async () => {
      await settle(150);
      return reopen();
    });
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await settle(30);
    file.insert(0, 'written during the reopen');
    file.close();
    await until(() => service.text('item-1@2') === 'written during the reopen');
    const wills = posted.filter((message) => (message as { t?: string })?.t === 'will') as { docName: string }[];
    expect(wills.map((will) => will.docName)).toEqual(['item-1@2']);
    await until(() => host.appFiles.close.mock.calls.length === 1);
    expect(host.appFiles.close).toHaveBeenCalledWith({ docName: 'item-1@2' });
    expect(service.keysOf('item-1@2')).toEqual([]);
  });

  it('let go of during a reopen that fails (the epoch moved on again meanwhile): said out loud — and no will of the old replica under the new epoch, which would write the file twice', async () => {
    const { service, open, host } = await loadPage<TextFile>('text');
    const posted: { t?: string; docName?: string }[] = [];
    const fromPage = service.fromPage.bind(service);
    service.fromPage = (message: unknown) => {
      if (!(message instanceof ArrayBuffer)) posted.push(message as { t?: string; docName?: string });
      fromPage(message);
    };
    service.write('item-1@1', 'shared');
    const file = await open();
    await until(() => file.text === 'shared');
    const reopen = host.appFiles.reopen.getMockImplementation()!;
    host.appFiles.reopen.mockImplementationOnce(async () => {
      await settle(150);
      const opened = await reopen();
      // Compacted again before this page's new replica gets there: item-1@2 is refused as stale.
      expect(await service.compact(opened.docName, 'item-1@3')).toBe(true);
      return opened;
    });
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await settle(30);
    file.insert(file.text.length, ' +mine');
    file.close();
    await until(() => host.appFiles.close.mock.calls.length === 1);
    const said = (host.reportError.mock.calls as unknown as [string][]).map(([message]) => message);
    expect(said.filter((message) => message.includes('is not kept'))).toHaveLength(1);
    const wills = posted.filter((message) => message.t === 'will');
    expect(wills.filter((will) => will.docName !== 'item-1@1')).toEqual([]);
  });

  it('after a swap the new replica is the file’s: refused later (stale — the file moved on while it was away), the file reopens there', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'kept');
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await until(() => file.saved && service.keysOf('item-1@2').length === 1);
    // Away a moment (rate-limited), and compacted meanwhile: its next Auth at @2 is refused as stale.
    service.closeDocument('item-1@2', 'rate-limited');
    expect(await service.compact('item-1@2', 'item-1@3')).toBe(true);
    await until(() => file.status === 'online' && file.saved && service.keysOf('item-1@3').length === 1, 8000);
    expect(service.text('item-1@3')).toBe('kept');
  });

  it('refused as stale on a reconnect, then reopened: nothing of this page waits at the service on the refused key', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'kept');
    await until(() => file.saved && service.text('item-1@1') === 'kept');
    // Away a moment (rate-limited), compacted meanwhile: its next Auth at @1 is refused as stale.
    service.closeDocument('item-1@1', 'rate-limited');
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await until(() => file.status === 'online' && file.saved && service.keysOf('item-1@2').length === 1, 8000);
    await settle(50);
    // A Close (or anything) on a key the service refused waits there for an Auth that never comes — one per
    // compaction, until the full queue resets main's whole socket.
    expect([...service.queued.keys()]).toEqual([]);
  });

  it('open for good: moved to a new epoch while it was away, five times, still online — the reopen count starts again at every sync', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'kept');
    await until(() => file.saved && service.text('item-1@1') === 'kept');
    for (let epoch = 1; epoch <= 5; epoch += 1) {
      service.closeDocument(`item-1@${epoch}`, 'rate-limited');
      expect(await service.compact(`item-1@${epoch}`, `item-1@${epoch + 1}`)).toBe(true);
      await until(() => file.status === 'online' && file.saved && service.keysOf(`item-1@${epoch + 1}`).length === 1, 8000);
    }
    expect(service.text('item-1@6')).toBe('kept');
  });

  it('refused as stale four times in a row, never syncing between: gone — the bound on reopens that get nowhere still holds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, open, host } = await loadPage<TextFile>('text');
    const file = await open();
    await untilAdvancing(() => file.saved, 3000);
    const reopen = host.appFiles.reopen.getMockImplementation()!;
    // Every reopen answers an epoch the service moves on from before the new replica gets there.
    host.appFiles.reopen.mockImplementation(async () => {
      const opened = await reopen();
      const at = Number(opened.docName.slice(opened.docName.lastIndexOf('@') + 1));
      expect(await service.compact(opened.docName, `item-1@${at + 1}`)).toBe(true);
      return opened;
    });
    service.closeDocument('item-1@1', 'rate-limited');
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await untilAdvancing(() => file.status === 'gone', 60_000);
    expect(host.appFiles.reopen).toHaveBeenCalledTimes(3);
  });

  it('a new replica refused (the epoch moved on again before it got there), three times over: none of them stays on the page’s socket — one provider, one connection', async () => {
    const { service, open, host } = await loadPage<TextFile>('text');
    const { pageSocket } = await import('./sync-link');
    const file = await open();
    file.insert(0, 'kept');
    await until(() => file.saved && service.text('item-1@1') === 'kept');
    const socket = await pageSocket();
    const reopen = host.appFiles.reopen.getMockImplementation()!;
    let epoch = 1;
    for (let round = 0; round < 3; round += 1) {
      const from = epoch;
      // This round's reopen answers an epoch the service moves on from before the new replica authenticates there;
      // the file then gets there on its own (stale-epoch → reopen at the epoch there is now).
      host.appFiles.reopen.mockImplementationOnce(async () => {
        const opened = await reopen();
        expect(await service.compact(opened.docName, `item-1@${from + 2}`)).toBe(true);
        return opened;
      });
      expect(await service.compact(`item-1@${from}`, `item-1@${from + 1}`)).toBe(true);
      epoch = from + 2;
      await until(() => file.status === 'online' && file.saved && service.keysOf(`item-1@${epoch}`).length === 1, 8000);
    }
    expect(socket.configuration.providerMap.size).toBe(1);
    expect(service.keys.size).toBe(1);
    expect(service.text(`item-1@${epoch}`)).toBe('kept');
    expect(file.text).toBe('kept');
  });

  it('closed while paused: what was kept goes out to the draining service', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await until(() => drainedFrom(service, since) === 1);
    file.insert(0, 'last words');
    file.close();
    await until(() => service.text('item-1@1') === 'last words');
  });

  it('what someone else wrote while this page was paused is written once: the replay starts from the shadow, not from what was last confirmed', async () => {
    const { service, open, host } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'A1 ');
    await until(() => file.saved && service.text('item-1@1') === 'A1 ');
    const since = service.stateless.length;
    service.say('item-1@1', { t: 'compact' });
    await until(() => drainedFrom(service, since) === 1);
    file.insert(file.text.length, 'A2 '); // this page's, kept while paused
    service.write('item-1@1', 'B1 '); // someone else's, reaching this page while it is paused
    await until(() => file.text.includes('B1 '));
    expect(await service.compact('item-1@1', 'item-1@2', { drain: false })).toBe(true);
    await until(() => file.saved && service.text('item-1@2') === file.text);
    expect(count(file.text, 'A2 ')).toBe(1);
    expect(count(file.text, 'B1 ')).toBe(1);
    expect((host.reportError.mock.calls as unknown as [string][]).filter(([message]) => message.includes('replayed'))).toEqual([]);
  });

  it('after the swap no Close of this page waits at the service for the old key (it would close whatever comes next on it)', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'x');
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await until(() => file.saved && service.keysOf('item-1@2').length === 1);
    await settle(50);
    expect([...service.queued.keys()]).toEqual([]);
  });
});
