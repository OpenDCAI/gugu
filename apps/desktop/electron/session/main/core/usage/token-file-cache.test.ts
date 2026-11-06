import { describe, expect, it } from 'vitest';
import { createParsedFileMemory, finishParsedFileHydration, hydrateParsedFileMemory, saveParsedFileParts, tokenCachePartRange,
  TOKEN_CACHE_PART_ENTRIES, type CachedLogFileSave, type CachedParsedFile } from './token-file-cache';
import { packParsedLogFile } from './token-log-file';

const path = '/fixture/%_中文/session.jsonl';
const make = (count: number): CachedParsedFile => ({ size: 1_000_000, mtimeMs: 1,
  parsed: { v: 1, offset: 100, state: { cumulative: 1 }, entries: Array.from({ length: count }, (_, i) => ({ key: 'k' + i, ts: i, model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })) } });
function storage() {
  const rows = new Map<string, CachedLogFileSave>(); const writes: CachedLogFileSave[] = [];
  const save = (file: CachedParsedFile) => saveParsedFileParts({ path, provider: 'codex', providerSessionId: 'session', file,
    previous: file.storage, fileId: '1:1', onSave: (row) => { writes.push(row); rows.set(row.path, row); } });
  const hydrate = (values = [...rows.values()]) => {
    const memory = createParsedFileMemory();
    for (const row of values.reverse()) hydrateParsedFileMemory(memory, [row]);
    finishParsedFileHydration(memory); return memory;
  };
  return { rows, writes, save, hydrate };
}

describe('segmented token file cache', () => {
  it('round-trips out-of-order pages; a one-entry append rewrites only the bounded tail and header', () => {
    const cache = storage(), file = make(2500); cache.save(file);
    expect(cache.rows.size).toBe(4);
    expect(JSON.parse(cache.rows.get(path)!.data)).toMatchObject({ kind: 'gugu-token-file-cache', format: 1, parserVersion: 1 });
    expect(cache.hydrate().files.get(path)?.parsed).toEqual(file.parsed);
    const old = new Map(cache.rows); cache.writes.length = 0;
    file.parsed.entries.push({ ...file.parsed.entries[0], key: 'appended' }); file.parsed.offset += 1;
    const result = cache.save(file);
    expect(result.writtenEntries).toBe(2501 % TOKEN_CACHE_PART_ENTRIES);
    expect(cache.writes).toHaveLength(2);
    const changed = new Set(cache.writes.map((row) => row.path));
    for (const [key, row] of old) if (!changed.has(key)) expect(cache.rows.get(key)?.data).toBe(row.data);
    expect(cache.hydrate().files.get(path)?.parsed).toEqual(file.parsed);
  });

  it('state-only append writes only the checkpoint; crossing a part boundary retains all entries', () => {
    const cache = storage(), file = make(TOKEN_CACHE_PART_ENTRIES); cache.save(file); cache.writes.length = 0;
    file.parsed.offset += 2; file.parsed.state = { cumulative: 2 };
    expect(cache.save(file).writtenEntries).toBe(0); expect(cache.writes).toHaveLength(1);
    cache.writes.length = 0; file.parsed.entries.push({ ...file.parsed.entries[0], key: 'next' });
    expect(cache.save(file).writtenEntries).toBe(1); expect(cache.writes).toHaveLength(2);
    expect(cache.hydrate().files.get(path)?.parsed).toEqual(file.parsed);
  });

  it('missing, corrupt and torn tail parts invalidate the cache instead of dropping tokens', () => {
    const cache = storage(), file = make(1500); cache.save(file);
    const part = [...cache.rows.keys()].find((key) => key !== path)!;
    expect(cache.hydrate([...cache.rows.values()].filter((row) => row.path !== part)).files.has(path)).toBe(false);
    const damaged = [...cache.rows.values()].map((row) => row.path === part ? { ...row, data: '{' } : row);
    expect(cache.hydrate(damaged).files.has(path)).toBe(false);
    const head = cache.rows.get(path)!;
    file.parsed.entries.push({ ...file.parsed.entries[0], key: 'new' }); cache.save(file);
    cache.rows.set(path, head); // crash after tail write, before the new head
    expect(cache.hydrate().files.has(path)).toBe(false);
  });

  it('reads legacy v1 and empty files without a schema migration', () => {
    const file = make(2), memory = createParsedFileMemory();
    hydrateParsedFileMemory(memory, [{ path, size: file.size, mtimeMs: file.mtimeMs, data: packParsedLogFile(file.parsed) }]);
    finishParsedFileHydration(memory); expect(memory.files.get(path)?.parsed).toEqual(file.parsed);
    const cache = storage(), empty = make(0); cache.save(empty);
    expect(cache.rows.size).toBe(1); expect(cache.hydrate().files.get(path)?.parsed).toEqual(empty.parsed);
  });

  it('keeps parser v2 quality and legacy keys separate from storage format 1', () => {
    const cache = storage(), file = make(4); file.parsed.v = 2;
    file.parsed.entries[0].quality = { complete: true, fields: 4 };
    file.parsed.entries[1].legacyKey = 'legacy';
    cache.save(file);
    expect(JSON.parse(cache.rows.get(path)!.data)).toMatchObject({ format: 1, parserVersion: 2 });
    expect(cache.hydrate().files.get(path)?.parsed).toEqual(file.parsed);
    const legacy = createParsedFileMemory();
    hydrateParsedFileMemory(legacy, [{ path, size: file.size, mtimeMs: 1, data: packParsedLogFile(file.parsed) }]);
    finishParsedFileHydration(legacy); expect(legacy.files.get(path)?.parsed).toEqual(file.parsed);
  });

  it('prefix ranges isolate files and generations even with wildcard characters', () => {
    const all = tokenCachePartRange(path), one = tokenCachePartRange(path, 'a'), other = tokenCachePartRange(path + 'other');
    expect(one.start >= all.start && one.start < all.end).toBe(true);
    expect(other.start >= all.start && other.start < all.end).toBe(false);
  });
  it.each(['timestamp', 'model-index', 'negative-tokens', 'reader-state'])('rejects malformed legacy cache: %s', (kind) => {
    const file = make(1), value = JSON.parse(packParsedLogFile(file.parsed));
    if (kind === 'timestamp') value.entries[0][1] = 1e100;
    if (kind === 'model-index') value.entries[0][2] = 999;
    if (kind === 'negative-tokens') value.entries[0][3] = -1;
    if (kind === 'reader-state') value.state = [];
    const memory = createParsedFileMemory();
    hydrateParsedFileMemory(memory, [{ path, size: file.size, mtimeMs: file.mtimeMs, data: JSON.stringify(value) }]);
    finishParsedFileHydration(memory); expect(memory.files.has(path)).toBe(false);
  });

});
