import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentTokenRefreshFrom, TOKEN_CACHE_VERSION } from './token-cache-version';
import { foldTokenEntries } from './token-fold';
import { packParsedLogFile, parseLogFile, unpackParsedLogFile } from './token-log-file';
import { claudeTokenReader } from './token-readers/claude';
import { collectTokenEntries, createParsedFileMemory, hydrateParsedFileMemory, type CachedLogFileSave } from './token-scan';

const cutoff = Date.parse('2026-10-30T00:00:00Z');
function line(key: string, ts: number, output: number, complete = false): string {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: key,
    message: { id: key, model: 'fixture', stop_reason: complete ? 'end_turn' : null,
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } });
}
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gugu-token-cache-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function fixture(lines: string[]) {
  const path = join(dir, 'fixture.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  const parsed = await parseLogFile(path, claudeTokenReader);
  // The actual previous on-disk tuple shape, with no quality or scoped identity fields.
  const data = JSON.stringify({ v: 1, offset: parsed.offset, state: null, models: ['fixture'],
    entries: parsed.entries.map(e => [e.key, e.ts, 0, e.input, e.output, e.cacheRead, e.cacheWrite]) });
  const memory = createParsedFileMemory();
  const stat = statSync(path);
  hydrateParsedFileMemory(memory, [{ path, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), data }]);
  const saved: CachedLogFileSave[] = [];
  const reader = { ...claudeTokenReader, locate: async () => new Map([['session', [path]]]) };
  return { path, data, memory, saved, options: { providerSessions: [{ provider: 'claude', providerSessionId: 'session' }],
    readers: [reader], rootsByProvider: {}, memory, refreshSinceMs: cutoff,
    onSave: (row: CachedLogFileSave) => { saved.push(row); } } };
}

describe('bounded token parser cache upgrades', () => {
  it('uses the same eight local calendar days as normal sync', () => {
    expect(recentTokenRefreshFrom(new Date(2026, 10, 6, 21, 10).getTime())).toBe(new Date(2026, 9, 30).getTime());
    expect(TOKEN_CACHE_VERSION).toBe(2);
  });

  it('round-trips quality and legacy identity in v2, and still reads the old v1 format', async () => {
    const f = await fixture([line('recent', cutoff, 1), line('recent', cutoff, 9, true)]);
    expect(unpackParsedLogFile(f.data)?.entries[0].quality).toBeUndefined();
    const parsed = await parseLogFile(f.path, claudeTokenReader);
    parsed.entries[0].legacyKey = 'legacy';
    expect(unpackParsedLogFile(packParsedLogFile(parsed))).toEqual(parsed);
    expect(unpackParsedLogFile('{"v":3,"offset":0,"entries":[]}')).toBeNull();
    expect(unpackParsedLogFile('{')).toBeNull();
  });

  it('upgrades recent duplicate snapshots but preserves older cached records byte-for-byte', async () => {
    const f = await fixture([line('old', cutoff - 1, 1), line('old', cutoff - 1, 50, true),
      line('recent', cutoff, 1), line('recent', cutoff, 9, true)]);
    const oldEntries = unpackParsedLogFile(f.data)!.entries.filter(e => e.ts < cutoff);
    const result = await collectTokenEntries(f.options);
    expect(result.stats).toMatchObject({ fullParses: 1, cacheHits: 0 });
    expect(result.entries.filter(e => e.ts < cutoff).map(({ provider: _p, providerSessionId: _s, ...e }) => e)).toEqual(oldEntries);
    // Old first=1 remains; only the recent request changes from 1 to 9.
    expect(foldTokenEntries(result.entries).reduce((n, row) => n + row.output, 0)).toBe(10);
    expect(f.saved).toHaveLength(1);
    expect(unpackParsedLogFile(f.saved[0].data)?.v).toBe(2);
  });

  it('does not reopen an unchanged all-old v1 file or rewrite its cache', async () => {
    const f = await fixture([line('old', cutoff - 1000, 1), line('old', cutoff - 1000, 50, true)]);
    const result = await collectTokenEntries(f.options);
    expect(result.stats).toMatchObject({ cacheHits: 1, bytesRead: 0, fullParses: 0 });
    expect(f.saved).toHaveLength(0);
    expect(f.memory.files.get(f.path)?.parsed.v).toBe(1);
    expect(foldTokenEntries(result.entries)[0].output).toBe(1);
  });

  it('upgrades an appended v1 file once without changing its historical counters', async () => {
    const f = await fixture([line('old', cutoff - 1, 1), line('old', cutoff - 1, 50, true)]);
    appendFileSync(f.path, `${line('new', cutoff + 1, 3)}\n${line('new', cutoff + 1, 12, true)}\n`);
    const first = await collectTokenEntries(f.options);
    expect(first.stats.fullParses).toBe(1);
    expect(foldTokenEntries(first.entries).reduce((n, row) => n + row.output, 0)).toBe(13);
    const second = await collectTokenEntries(f.options);
    expect(second.stats).toMatchObject({ cacheHits: 1, bytesRead: 0 });
    expect(f.saved).toHaveLength(1);
  });

  it('resumes a v2 cache for appended final snapshots and retains quality across hydration', async () => {
    const f = await fixture([line('recent', cutoff, 1)]);
    await collectTokenEntries(f.options);
    const memory = createParsedFileMemory();
    hydrateParsedFileMemory(memory, f.saved);
    const appended = `${line('recent', cutoff, 19, true)}\n`;
    appendFileSync(f.path, appended);
    const result = await collectTokenEntries({ ...f.options, memory });
    expect(result.stats).toMatchObject({ resumed: 1, fullParses: 0, bytesRead: Buffer.byteLength(appended) });
    expect(foldTokenEntries(result.entries)[0].output).toBe(19);
    expect(result.entries[1].quality).toEqual({ complete: true, fields: 4 });
  });

  it('applies legacy first-wins to old records on a fresh cache, without dropping their totals', async () => {
    const f = await fixture([line('old', cutoff - 1, 1), line('old', cutoff - 1, 50, true), line('new', cutoff, 4)]);
    const result = await collectTokenEntries({ ...f.options, memory: createParsedFileMemory() });
    expect(result.entries.filter(e => e.ts < cutoff).every(e => !e.quality)).toBe(true);
    expect(foldTokenEntries(result.entries).reduce((n, row) => n + row.output, 0)).toBe(5);
  });
});
