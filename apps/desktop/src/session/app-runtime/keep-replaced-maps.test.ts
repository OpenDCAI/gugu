import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { loadPage } from './fake-file-service';
import { keepReplacedMaps } from '@gugu/files-core/concurrent';

/**
 * 摩擦单 F43, the page's half. Two ends create the same nested path at once (`f.data.votes[10][me] = 1` with no
 * `votes[10]` yet): each makes a map for the same key, one loses, and the file service merges the loser into the
 * winner (gugu-supabase `services/files/src/concurrent.mjs`). An end that was offline hears the winner first on
 * reconnect and deletes its own map locally — the page must not garbage-collect it before sending it, or the service
 * has nothing to merge. Same rule, same test as the service's own cell 「离线的一端重连时先收到胜者」.
 */

/** Pages talk only to the hub, as with the file service; map-key conflicts go to the higher clientID, so A loses. */
function world(keep: boolean) {
  const hub = new Y.Doc();
  const [A, B] = [1, 2].map((id) => {
    const doc = new Y.Doc();
    if (keep) keepReplacedMaps(doc);
    doc.clientID = id;
    return doc;
  });
  const up = (page: Y.Doc) => Y.applyUpdate(hub, Y.encodeStateAsUpdate(page, Y.encodeStateVector(hub)));
  const down = (page: Y.Doc) => Y.applyUpdate(page, Y.encodeStateAsUpdate(hub, Y.encodeStateVector(page)));
  return { hub, A: A!, B: B!, up, down };
}

/** The way the runtime writes a path: a missing map on the way is made by the end writing it. */
function write(doc: Y.Doc, keys: string[], leafKey: string, leaf: unknown): void {
  doc.transact(() => {
    let map = doc.getMap('root');
    for (const key of keys) {
      if (!(map.get(key) instanceof Y.Map)) map.set(key, new Y.Map());
      map = map.get(key) as Y.Map<unknown>;
    }
    map.set(leafKey, leaf);
  });
}

function toYMap(entries: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

/** Does this update still carry an entry under `key` with its value (not a garbage-collected hole)? */
function carries(update: Uint8Array, key: string): boolean {
  return Y.decodeUpdate(update).structs.some(
    (struct) => struct instanceof Y.Item && struct.parentSub === key && struct.content.getContent().length > 0,
  );
}

describe('keepReplacedMaps on the page (摩擦单 F43)', () => {
  it('offline, then the winner arrives first: what the page sends still holds its own entries', () => {
    for (const keep of [false, true]) {
      const { hub, A, B, up, down } = world(keep);
      write(A, ['votes', '10'], 'userA', 1); // written while offline
      write(B, ['votes', '10'], 'userB', 1);
      up(B);
      down(A); // reconnect: the hub's first — B's map wins, A's own is deleted here
      const sent = Y.encodeStateAsUpdate(A, Y.encodeStateVector(hub));
      // Control (no rule): A's entry was collected before it could be sent — the service has nothing to merge.
      expect(carries(sent, 'userA')).toBe(keep);
    }
  });

  it('a map simply deleted is collected; one replaced on its key is kept (摩擦单 F61)', () => {
    const deleted = new Y.Doc();
    keepReplacedMaps(deleted);
    deleted.getMap('root').set('x', toYMap({ a: 1 }));
    deleted.getMap('root').delete('x');
    // `delete f.data.x`: nothing to merge into — it must not stay in the replica for good.
    expect(carries(Y.encodeStateAsUpdate(deleted), 'a')).toBe(false);

    const replaced = new Y.Doc();
    keepReplacedMaps(replaced);
    replaced.getMap('root').set('x', toYMap({ a: 1 }));
    replaced.getMap('root').set('x', toYMap({ b: 2 }));
    expect(carries(Y.encodeStateAsUpdate(replaced), 'a')).toBe(true);
    // A replaced map deleted later is still a replaced map (the loser of a creation at the same moment stays one).
    replaced.getMap('root').delete('x');
    expect(carries(Y.encodeStateAsUpdate(replaced), 'a')).toBe(true);
    expect(carries(Y.encodeStateAsUpdate(replaced), 'b')).toBe(false);
  });

  it('only replaced maps are kept: letters deleted from a collaborative text are still collected', () => {
    const lettersKept = (install: (doc: Y.Doc) => void) => {
      const doc = new Y.Doc();
      install(doc);
      const body = new Y.Text('hello world');
      doc.getMap('root').set('body', body);
      body.delete(0, 6);
      return Y.decodeUpdate(Y.encodeStateAsUpdate(doc))
        .structs.map((struct) => (struct instanceof Y.Item ? (struct.content as { str?: unknown }).str : undefined))
        .filter((str): str is string => typeof str === 'string')
        .join('');
    };
    expect(lettersKept(keepReplacedMaps)).toBe('world');
    // Control: a filter that kept everything would keep the deleted letters too.
    expect(lettersKept((doc) => (doc.gcFilter = () => false))).toBe('hello world');
  });

  it('is on for every JSON file the runtime opens (and replaced there is kept, not collected)', async () => {
    const { open, internals } = await loadPage<{ data: Record<string, unknown>; close(): void }>('json');
    const file = await open();
    file.data.votes = { a: 1 };
    // Replaced by another kind of value (an object would be merged into it, key by key).
    file.data.votes = 0;
    const doc = internals.get(file)?.doc;
    expect(doc).toBeDefined();
    // The `votes` map was replaced: its entry `a` is still in the replica (deleted, not collected).
    expect(carries(Y.encodeStateAsUpdate(doc!), 'a')).toBe(true);
    expect(file.data.votes).toBe(0);
    file.close();
  });
});
