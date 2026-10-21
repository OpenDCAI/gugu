import { describe, expect, it, vi } from 'vitest';
import { coalescedReads, MAX_HELD_IDS, type WantedIds, type WantedRead } from './coalesced-reads';

/**
 * #7257: one read at a time per key — what is named meanwhile goes in exactly one more; a read that fails is tried again
 * at once, and failing again its ids go with the key's next read (a blip must not leave a list stale; a lasting failure
 * must not spin). The reads are fakes that record what they were asked and can be held open or made to fail.
 */

function rig() {
  const asked: { key: string; ids: string[]; all: boolean }[] = [];
  const failures: unknown[] = [];
  let fail = 0;
  let hold: Promise<void> | null = null;
  const reads = coalescedReads((key, error) => failures.push([key, error]));
  const read = (key: string) => async (wanted: WantedRead) => {
    asked.push({ key, ids: [...wanted.ids].sort(), all: wanted.all });
    if (hold) await hold;
    if (fail > 0) {
      fail -= 1;
      throw new Error('offline');
    }
  };
  return {
    asked,
    failures,
    want: (key: string, ids: WantedIds) => reads.want(key, ids, read(key)),
    forget: (key: string) => reads.forget(key),
    failNext: (n: number) => (fail = n),
    holdOpen: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

describe('coalescedReads', () => {
  it('ids named while a read is out wait for it and go together in exactly one more; another key reads on its own', async () => {
    const r = rig();
    const release = r.holdOpen();
    const first = r.want('chat-1', ['a']);
    const second = r.want('chat-1', ['b']);
    const third = r.want('chat-1', ['c', 'b']);
    const other = r.want('chat-2', ['z']);
    release();
    await Promise.all([first, second, third, other]);
    expect(r.asked).toEqual([
      { key: 'chat-1', ids: ['a'], all: false },
      { key: 'chat-2', ids: ['z'], all: false },
      { key: 'chat-1', ids: ['b', 'c'], all: false },
    ]);
  }, 30_000);

  it('a read that fails once is tried again at once: nothing is lost, nothing said', async () => {
    const r = rig();
    r.failNext(1);
    await r.want('chat-1', ['a']);
    expect(r.asked).toEqual([{ key: 'chat-1', ids: ['a'], all: false }, { key: 'chat-1', ids: ['a'], all: false }]);
    expect(r.failures).toEqual([]);
  }, 30_000);

  it('failing again, its ids go with the key\'s next read — said once, never tried on their own again', async () => {
    const r = rig();
    r.failNext(2);
    await r.want('chat-1', ['a']);
    expect(r.asked).toHaveLength(2);
    expect(r.failures).toHaveLength(1);
    // No timer: nothing more is read until the key is named again.
    await r.want('chat-1', ['b']);
    expect(r.asked.slice(2)).toEqual([{ key: 'chat-1', ids: ['a', 'b'], all: false }]);
    // Read: they are not carried any further.
    await r.want('chat-1', ['c']);
    expect(r.asked.slice(3)).toEqual([{ key: 'chat-1', ids: ['c'], all: false }]);
  }, 30_000);

  it('held ids go with the key\'s next read; `all` named while it is out makes the one after of every file, the ids still named', async () => {
    const r = rig();
    r.failNext(2);
    await r.want('chat-1', ['a']);
    const release = r.holdOpen();
    const first = r.want('chat-1', ['b']);
    const second = r.want('chat-1', 'all');
    const third = r.want('chat-1', ['c']);
    release();
    await Promise.all([first, second, third]);
    // `ids` with `all`: what is not among every file is gone — the reader says so (`groupChange`).
    expect(r.asked.slice(2)).toEqual([{ key: 'chat-1', ids: ['a', 'b'], all: false }, { key: 'chat-1', ids: ['c'], all: true }]);
  }, 30_000);

  it('never rejects: a read that throws is the failure callback\'s to say', async () => {
    const failed = vi.fn();
    const reads = coalescedReads(failed);
    await expect(reads.want('k', ['a'], async () => { throw new Error('down'); })).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledTimes(1);
  }, 30_000);

  it(`more than ${MAX_HELD_IDS} ids: a read of every file, not one per id — and every id still named, kept past a failure`, async () => {
    const many = Array.from({ length: MAX_HELD_IDS + 1 }, (_, i) => `id-${i}`);
    const r = rig();
    r.failNext(2);
    await r.want('chat-1', many);
    expect(r.asked.map((read) => [read.ids.length, read.all])).toEqual([[MAX_HELD_IDS + 1, true], [MAX_HELD_IDS + 1, true]]);
    await r.want('chat-1', ['b']);
    // #7257 review 2: a deleted one among them is still said gone — the ids are not dropped when the read goes to all.
    expect(r.asked.at(-1)).toEqual({ key: 'chat-1', ids: [...many, 'b'].sort(), all: true });
    // Control: as many as the cap are read as they are.
    const c = rig();
    c.failNext(2);
    await c.want('chat-1', many.slice(1));
    await c.want('chat-1', ['id-1']);
    expect(c.asked.map((read) => [read.ids.length, read.all])).toEqual([[MAX_HELD_IDS, false], [MAX_HELD_IDS, false], [MAX_HELD_IDS, false]]);
  }, 30_000);

  it('forget: what was kept for a key nobody hears any more goes — the next read is only its own ids', async () => {
    const r = rig();
    r.failNext(2);
    await r.want('chat-1', ['a']);
    r.forget('chat-1');
    await r.want('chat-1', ['b']);
    expect(r.asked.at(-1)).toEqual({ key: 'chat-1', ids: ['b'], all: false });
  }, 30_000);
});
