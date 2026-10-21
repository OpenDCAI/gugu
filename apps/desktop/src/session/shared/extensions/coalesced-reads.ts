/** Ids to read: some, or `'all'` (every file of the key). */
export type WantedIds = readonly string[] | 'all';

/** What a read is asked: `ids` the files named; `all` — every file of the key, the named ones not among them gone. */
export interface WantedRead {
  ids: readonly string[];
  all: boolean;
}

/** Past this many named ids, a read is of every file (one read, not one per id: an agent's reads are one RPC each); the
 *  ids are kept all the same — what is not among every file is gone. */
export const MAX_HELD_IDS = 50;

type Wanted = { ids: Set<string>; all: boolean };
const merge = (a: Wanted | null, b: Wanted | WantedIds | null): Wanted | null => {
  if (!b) return a;
  const more: { ids: Iterable<string>; all: boolean } = b === 'all' ? { ids: [], all: true } : 'all' in b ? b : { ids: b, all: false };
  return { ids: new Set([...(a?.ids ?? []), ...more.ids]), all: (a?.all ?? false) || more.all };
};
const asked = (wanted: Wanted): WantedRead => ({ ids: [...wanted.ids], all: wanted.all || wanted.ids.size > MAX_HELD_IDS });

export interface CoalescedReads {
  /**
   * Read `ids` for `key` with `read` — at once, or with the read on its way when it is back. Settles when the read it
   * started or joined is done (never rejects: the failure callback hears why). One `read` per key: the one passed with a
   * key's first call is the one used while its reads go on; later calls' `read` for that key are ignored.
   */
  want(key: string, ids: WantedIds, read: (wanted: WantedRead) => Promise<void>): Promise<void>;
  /** Nobody hears `key` any more (its page went, it stopped listening): the ids kept for it go. */
  forget(key: string): void;
}

/**
 * One read at a time per key (#7257: a chat's files a page hears of — the desktop's main keys by chat and reader, a
 * phone's host by chat for its page). Ids named while a read is on its way wait for it and go together in exactly one
 * more: the read itself is the batch's edge, no timer. A read that fails is tried again at once; failing again, its ids
 * stay with the key and go with its next read — so a blip does not leave a list stale, and a lasting failure does not
 * spin. Past MAX_HELD_IDS ids a read is of every file, the ids still named (what is not among every file is gone).
 */
export function coalescedReads(failed: (key: string, error: unknown) => void): CoalescedReads {
  const runs = new Map<string, { next: Wanted | null; done: Promise<void> }>();
  const held = new Map<string, Wanted>();
  const take = (key: string) => {
    const kept = held.get(key) ?? null;
    held.delete(key);
    return kept;
  };
  return {
    want(key, ids, read) {
      const running = runs.get(key);
      if (running) {
        running.next = merge(running.next, ids);
        return running.done;
      }
      const run: { next: Wanted | null; done: Promise<void> } = { next: null, done: Promise.resolve() };
      runs.set(key, run);
      run.done = (async () => {
        for (let wanted = merge(take(key), ids); wanted; ) {
          const reading = wanted;
          try {
            await read(asked(reading)).catch(() => read(asked(reading)));
          } catch (error) {
            failed(key, error);
            held.set(key, merge(held.get(key) ?? null, reading)!);
          }
          wanted = run.next ? merge(take(key), run.next) : null;
          run.next = null;
        }
        runs.delete(key);
      })();
      return run.done;
    },
    forget(key) {
      held.delete(key);
    },
  };
}
