import { isTextMark, spliceText } from '@gugu/files-core/content';
import * as Y from 'yjs';
import { guguError } from './host';

/**
 * A JSON file's content as a live object: reads see the replica, writes go straight into
 * it (and from there to everyone who has the file open).
 *
 * The shape on the wire is fixed by the file service (真源 §2.2): the root is a Y.Map,
 * nested objects are Y.Maps and arrays are Y.Arrays. So merging is per key — different
 * keys all survive, the same key is last-writer-wins — and concurrent pushes to an array
 * all survive. The App never sees a Y type.
 */

type Writable = () => boolean;

/** Live proxies per Y type, one set per handle (`writable` is the handle's: 摩擦单 F46), so `f.data.a === f.data.a`. */
const proxies = new WeakMap<Writable, WeakMap<object, object>>();

function proxiesOf(writable: Writable): WeakMap<object, object> {
  let cache = proxies.get(writable);
  if (!cache) {
    cache = new WeakMap();
    proxies.set(writable, cache);
  }
  return cache;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Collaborative text in a JSON file (摩擦单 F8) is `{ "$text": "…" }` (`isTextMark`), and a string put where it is goes
 * in by splice (`spliceText`) — both are @gugu/files-core's, the file service's own, so an App and an agent declare
 * and edit it alike.
 *
 * Writes `value` into what is already there, when it can — the rule of the file service's `applyJson` for an agent's
 * JSON (统筹 04:04), kept here rather than imported because an App's values are not parsed JSON: a live proxy handed
 * back is unwrapped, `undefined` is left out, and what JSON cannot hold is refused naming its path (`toY`). An object
 * goes into a map key by key (keys it could see but did not list go;
 * keys others added meanwhile it never saw, so they stay — `= {}` clears what it saw), a string into collaborative
 * text by splice, a value into itself (a live proxy handed back, as `{ ...f.data.slides }` hands them) as nothing.
 * False: not mergeable — the caller replaces it.
 */
function mergeInto(current: unknown, value: unknown): boolean {
  if (current instanceof Y.AbstractType && unwrap(value) === current) return true;
  if (current instanceof Y.Text && (typeof value === 'string' || isTextMark(value))) {
    spliceText(current, typeof value === 'string' ? value : value.$text);
    return true;
  }
  if (current instanceof Y.Map && isPlainObject(value) && !isTextMark(value)) {
    for (const existing of [...current.keys()]) if (!(existing in value) || value[existing] === undefined) current.delete(existing);
    for (const [inner, v] of Object.entries(value)) if (v !== undefined) mergeValue(current, inner, v);
    return true;
  }
  if (current instanceof Y.Array && Array.isArray(value)) {
    mergeArray(current, value);
    return true;
  }
  // The same plain value again is not written: it would claim the key (last writer wins) for nothing. (Objects and
  // arrays were merged above; anything else goes to `toY`, which refuses what JSON cannot hold.)
  return (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') && current === value;
}

/** What a stored value or a live proxy reads as, for comparing. */
const plain = (value: unknown): unknown => {
  const source = unwrap(value);
  return source instanceof Y.AbstractType ? source.toJSON() : source;
};
const same = (a: unknown, b: unknown) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

/**
 * An array written over an array (the file service's `applyArray`): the same elements at either end stay, the ones
 * paired up in between are merged in place (maps and collaborative text in them keep who they are), the rest are
 * inserted or deleted. Two ends creating the same array at once is another matter (F43: a value, last writer wins).
 */
function mergeArray(array: Y.Array<unknown>, next: readonly unknown[]): void {
  const old = array.toArray();
  let start = 0;
  while (start < old.length && start < next.length && same(old[start], next[start])) start += 1;
  let tail = 0;
  while (tail < old.length - start && tail < next.length - start && same(old[old.length - 1 - tail], next[next.length - 1 - tail])) tail += 1;
  const oldMiddle = old.length - start - tail;
  const nextMiddle = next.length - start - tail;
  const paired = Math.min(oldMiddle, nextMiddle);
  for (let i = 0; i < paired; i += 1) {
    const value = next[start + i] === undefined ? null : next[start + i];
    if (!mergeInto(old[start + i], value)) {
      array.delete(start + i, 1);
      array.insert(start + i, [toY(value, `[${start + i}]`)]);
    }
  }
  if (oldMiddle > paired) array.delete(start + paired, oldMiddle - paired);
  if (nextMiddle > paired) {
    array.insert(start + paired, next.slice(start + paired, start + nextMiddle).map((v, i) => toY(v === undefined ? null : v, `[${start + paired + i}]`)));
  }
}

/** Puts `value` at `key` of `map`: merged into what is there (`mergeInto`), else stored in its place. */
export function mergeValue(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (!mergeInto(map.get(key), value)) map.set(key, toY(value, key));
}


/** A value about to be stored, turned into what the file service expects. */
export function toY(value: unknown, path = 'value'): unknown {
  // A live proxy handed back in (`f.data.b = f.data.a`): a Y type cannot sit in two places,
  // so it is copied by value — which is also what the App meant.
  const source = unwrap(value);
  if (source instanceof Y.AbstractType) return toY(source.toJSON(), path);
  if (source === null || typeof source === 'string' || typeof source === 'boolean') return source;
  if (isTextMark(source)) return new Y.Text(source.$text);
  if (typeof source === 'number') {
    if (!Number.isFinite(source)) throw guguError('invalid', `${path}: JSON has no ${String(source)}`);
    return source;
  }
  if (Array.isArray(source)) {
    const array = new Y.Array<unknown>();
    array.push(source.map((item, i) => toY(item === undefined ? null : item, `${path}[${i}]`)));
    return array;
  }
  if (isPlainObject(source)) {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(source)) {
      if (item !== undefined) map.set(key, toY(item, `${path}.${key}`));
    }
    return map;
  }
  throw guguError('invalid', `${path}: only JSON values can be stored (got ${Object.prototype.toString.call(source)})`);
}

const RAW = Symbol('gugu.raw');

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const raw = (value as { [RAW]?: unknown })[RAW];
    if (raw) return raw;
  }
  return value;
}

export function fromY(value: unknown, writable: Writable): unknown {
  if (value instanceof Y.Map) return mapProxy(value, writable);
  if (value instanceof Y.Array) return arrayProxy(value, writable);
  if (value instanceof Y.Text) return value.toString();
  return value;
}

function ensureWritable(writable: Writable): void {
  if (!writable()) throw guguError('read-only', 'This file is open read-only');
}

function transact(type: { doc: Y.Doc | null }, fn: () => void): void {
  const doc = type.doc;
  if (doc) doc.transact(fn);
  else fn();
}

export function mapProxy(map: Y.Map<unknown>, writable: Writable): Record<string, unknown> {
  const cached = proxiesOf(writable).get(map);
  if (cached) return cached as Record<string, unknown>;
  const proxy = new Proxy(Object.create(null) as Record<string | symbol, unknown>, {
    get(_target, key) {
      if (key === RAW) return map;
      if (key === 'toJSON') return () => map.toJSON();
      if (typeof key === 'symbol') return undefined;
      return fromY(map.get(key), writable);
    },
    set(_target, key, value) {
      if (typeof key === 'symbol') return false;
      ensureWritable(writable);
      transact(map, () => {
        if (value === undefined) map.delete(key);
        else mergeValue(map, key, value);
      });
      return true;
    },
    deleteProperty(_target, key) {
      if (typeof key === 'symbol') return false;
      ensureWritable(writable);
      transact(map, () => map.delete(key));
      return true;
    },
    has(_target, key) {
      return typeof key === 'string' && map.has(key);
    },
    ownKeys() {
      return [...map.keys()];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string' || !map.has(key)) return undefined;
      return { enumerable: true, configurable: true, writable: true, value: fromY(map.get(key), writable) };
    },
    defineProperty() {
      throw guguError('invalid', 'Assign the value instead (data.key = value)');
    },
  });
  proxiesOf(writable).set(map, proxy);
  return proxy as Record<string, unknown>;
}

function index(key: string | symbol): number | null {
  if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return null;
  return Number(key);
}

export function arrayProxy(array: Y.Array<unknown>, writable: Writable): unknown[] {
  const cached = proxiesOf(writable).get(array);
  if (cached) return cached as unknown[];
  const items = () => array.toArray().map((item) => fromY(item, writable));
  const write = (fn: () => void) => {
    ensureWritable(writable);
    transact(array, fn);
  };
  // Mutators the App reaches for; each is one transaction. Readers run over a snapshot of
  // live children, so `list.map((p) => p.name)` and `list.find(...)` behave as on an array.
  const mutators: Record<string, (...args: unknown[]) => unknown> = {
    push: (...values) => {
      write(() => array.push(values.map((v, i) => toY(v, `[${array.length + i}]`))));
      return array.length;
    },
    unshift: (...values) => {
      write(() => array.insert(0, values.map((v, i) => toY(v, `[${i}]`))));
      return array.length;
    },
    pop: () => {
      if (array.length === 0) return undefined;
      const last = array.get(array.length - 1);
      const value = last instanceof Y.AbstractType ? last.toJSON() : last;
      write(() => array.delete(array.length - 1, 1));
      return value;
    },
    shift: () => {
      if (array.length === 0) return undefined;
      const first = array.get(0);
      const value = first instanceof Y.AbstractType ? first.toJSON() : first;
      write(() => array.delete(0, 1));
      return value;
    },
    splice: (start, deleteCount, ...values) => {
      const len = array.length;
      const from = Math.min(Math.max(Number(start ?? 0) < 0 ? len + Number(start) : Number(start ?? 0), 0), len);
      const count = deleteCount === undefined ? len - from : Math.min(Math.max(Number(deleteCount), 0), len - from);
      const removed = array.slice(from, from + count).map((item) => (item instanceof Y.AbstractType ? item.toJSON() : item));
      write(() => {
        if (count > 0) array.delete(from, count);
        if (values.length > 0) array.insert(from, values.map((v, i) => toY(v, `[${from + i}]`)));
      });
      return removed;
    },
  };
  const proxy = new Proxy([] as unknown[], {
    get(target, key) {
      if (key === RAW) return array;
      if (key === 'length') return array.length;
      if (key === 'toJSON') return () => array.toJSON();
      const at = index(key);
      if (at !== null) return at < array.length ? fromY(array.get(at), writable) : undefined;
      if (typeof key === 'string' && Object.hasOwn(mutators, key)) return mutators[key];
      if (key === Symbol.iterator) return () => items()[Symbol.iterator]();
      const method = (Array.prototype as unknown as Record<string | symbol, unknown>)[key];
      if (typeof method === 'function') {
        return (...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply(items(), args);
      }
      return Reflect.get(target, key);
    },
    set(_target, key, value) {
      if (key === 'length') {
        const next = Number(value);
        if (!Number.isInteger(next) || next < 0) throw guguError('invalid', 'length must be a whole number');
        if (next < array.length) write(() => array.delete(next, array.length - next));
        else if (next > array.length) write(() => array.push(Array.from({ length: next - array.length }, () => null)));
        return true;
      }
      const at = index(key);
      if (at === null) throw guguError('invalid', 'Only indexes and length can be set on a shared array');
      write(() => {
        // Merged into the element that is there, when it can be (the same rule as a map's key).
        if (at < array.length && value !== undefined && mergeInto(array.get(at), value)) return;
        if (at < array.length) {
          array.delete(at, 1);
          array.insert(at, [toY(value === undefined ? null : value, `[${at}]`)]);
        } else {
          const gap = Array.from({ length: at - array.length }, () => null);
          array.push([...gap, toY(value === undefined ? null : value, `[${at}]`)]);
        }
      });
      return true;
    },
    deleteProperty(_target, key) {
      const at = index(key);
      if (at === null || at >= array.length) return true;
      write(() => {
        array.delete(at, 1);
        array.insert(at, [null]);
      });
      return true;
    },
    has(_target, key) {
      const at = index(key);
      return at !== null ? at < array.length : key === 'length';
    },
    ownKeys() {
      return [...Array.from({ length: array.length }, (_, i) => String(i)), 'length'];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'length') return { enumerable: false, configurable: false, writable: true, value: array.length };
      const at = index(key);
      if (at === null || at >= array.length) return undefined;
      return { enumerable: true, configurable: true, writable: true, value: fromY(array.get(at), writable) };
    },
  });
  proxiesOf(writable).set(array, proxy);
  return proxy;
}
