import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mapProxy } from './json-proxy';

/** Two replicas that exchange updates, the way two pages in one open file do. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(b, u, 'net'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(a, u, 'net'));
  const writable = () => true;
  return { a, b, da: mapProxy(a.getMap('root'), writable), db: mapProxy(b.getMap('root'), writable) };
}

describe('JSON file data', () => {
  it('reads and writes like a plain object, nested objects and arrays included', () => {
    const { a, da, db } = pair();
    da.food = [3, 4];
    da.scores = { alice: 1 };
    (da.scores as Record<string, number>).bob = 2;
    (da.scores as Record<string, number>).alice += 1;
    expect(db.food).toEqual([3, 4]);
    expect(JSON.parse(JSON.stringify(db))).toEqual({ food: [3, 4], scores: { alice: 2, bob: 2 } });
    // The wire shape the file service expects: nested map, nested array.
    expect(a.getMap('root').get('scores')).toBeInstanceOf(Y.Map);
    expect(a.getMap('root').get('food')).toBeInstanceOf(Y.Array);
    expect(Object.keys(db)).toEqual(['food', 'scores']);
    expect({ ...(db.scores as object) }).toEqual({ alice: 2, bob: 2 });
  });

  it('keeps both sides of concurrent writes to different keys, and one of the same key', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const da = mapProxy(a.getMap('root'), () => true);
    const db = mapProxy(b.getMap('root'), () => true);
    da.x = 1;
    db.y = 2;
    da.same = 'a';
    db.same = 'b';
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(da.x).toBe(1);
    expect(da.y).toBe(2);
    expect(da.same).toBe(db.same);
  });

  it('keeps every concurrent push to an array', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const da = mapProxy(a.getMap('root'), () => true);
    const db = mapProxy(b.getMap('root'), () => true);
    da.log = [];
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Neither has seen the other's push yet.
    (da.log as unknown[]).push('a1');
    (db.log as unknown[]).push('b1');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect([...(db.log as unknown[])].sort()).toEqual(['a1', 'b1']);
    expect(a.getMap('root').toJSON()).toEqual(b.getMap('root').toJSON());
  });

  it('supports the array verbs an App reaches for', () => {
    const { da } = pair();
    da.list = [1, 2, 3];
    const list = da.list as number[];
    expect(list.length).toBe(3);
    expect(list.map((n) => n * 2)).toEqual([2, 4, 6]);
    expect(list.splice(1, 1, 9, 8)).toEqual([2]);
    expect([...list]).toEqual([1, 9, 8, 3]);
    list[0] = 7;
    expect(list.pop()).toBe(3);
    expect(list.shift()).toBe(7);
    list.unshift(0);
    expect(JSON.parse(JSON.stringify(da))).toEqual({ list: [0, 9, 8] });
    expect(Array.isArray(list)).toBe(true);
    list.length = 1;
    expect([...list]).toEqual([0]);
  });

  it('hands back the same live object each time, and copies a live object assigned elsewhere', () => {
    const { da } = pair();
    da.a = { n: 1 };
    expect(da.a).toBe(da.a);
    da.b = da.a;
    (da.b as { n: number }).n = 2;
    expect((da.a as { n: number }).n).toBe(1);
  });

  it('deletes on undefined and delete, and refuses what JSON cannot hold', () => {
    const { da } = pair();
    da.x = 1;
    da.x = undefined;
    expect('x' in da).toBe(false);
    da.y = 1;
    delete da.y;
    expect(da.y).toBeUndefined();
    expect(() => (da.bad = new Date())).toThrow(/only JSON values/);
    expect(() => (da.bad = Number.NaN)).toThrow(/JSON has no NaN/);
    expect(() => (da.bad = () => 1)).toThrow(/only JSON values/);
  });

  it('refuses writes to a read-only file', () => {
    const doc = new Y.Doc();
    const data = mapProxy(doc.getMap('root'), () => false);
    let error: unknown;
    try {
      data.x = 1;
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe('read-only');
    expect(doc.getMap('root').size).toBe(0);
  });
});
