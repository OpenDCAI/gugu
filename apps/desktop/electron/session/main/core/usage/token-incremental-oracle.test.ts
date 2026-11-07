import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIncrementalTokenFold } from './incremental-token-fold';
import { createCodexForkCache } from './token-fork-cache';
import { canonicalizeCodexForks } from './token-forks';
import { foldTokenEntries, type TokenDayRow } from './token-fold';
import { packParsedLogFile, parseLogFile } from './token-log-file';
import { claudeTokenReader } from './token-readers/claude';
import { codexTokenReader } from './token-readers/codex';
import { collectTokenEntries, createParsedFileMemory, hydrateParsedFileMemory, type CachedLogFileSave } from './token-scan';

const sort = (rows: TokenDayRow[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const cutoff = Date.parse('2026-10-30T00:00:00Z');
const meta = (id: string, parent?: string) => JSON.stringify({ type: 'session_meta', payload: { id, forked_from_id: parent } }) + '\n';
const usage = (n: number, extra = 0) => JSON.stringify({ type: 'event_msg', timestamp: new Date(cutoff + n * 1000).toISOString(),
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n * 100 + extra, cached_input_tokens: n * 40,
    cache_write_input_tokens: n * 10, output_tokens: n * 10, total_tokens: n * 110 + extra } } } }) + '\n';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gugu-token-oracle-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('incremental scan versus the 1914 full fold oracle', () => {
  it('retains fork lineage across append, missing parents, divergence, cycles, scope changes and hydration', async () => {
    const paths = new Map(['p', 'c', 'g', 'u'].map((id) => [id, join(dir, id + '.jsonl')]));
    const write = (id: string, text: string) => writeFileSync(paths.get(id)!, text);
    write('p', meta('p') + usage(1) + usage(2));
    write('c', meta('c', 'p') + usage(1) + usage(2) + usage(3));
    write('g', meta('g', 'c') + usage(1) + usage(2) + usage(3));
    write('u', meta('u') + usage(1));
    let ids = ['c', 'p', 'g', 'u'];
    const reader = { ...codexTokenReader, locate: async () => new Map(ids.map((id) => [id, [paths.get(id)!]])) };
    let memory = createParsedFileMemory(), fold = createIncrementalTokenFold();
    const saved = new Map<string, CachedLogFileSave>();
    const run = async () => {
      fold.begin({ c: { fallback: 'byok', spans: [] } });
      const result = await collectTokenEntries({ providerSessions: ids.map((providerSessionId) => ({ provider: 'codex', providerSessionId })),
        readers: [reader], rootsByProvider: {}, memory, refreshSinceMs: cutoff, onSave: (row) => { saved.set(row.path, row); },
        onFile: (file) => fold.visit(file) });
      const actual = fold.finish();
      const files = ids.map((id) => ({ path: paths.get(id)!, parsed: memory.files.get(paths.get(id)!)!.parsed }));
      const normalized = canonicalizeCodexForks(files);
      const reference = foldTokenEntries(files.flatMap((file, i) => normalized.get(file.path)!.map((entry) => ({ ...entry,
        provider: 'codex', providerSessionId: ids[i] }))), { c: { fallback: 'byok', spans: [] } });
      expect(sort(actual.rows)).toEqual(sort(reference));
      return { actual, stats: result.stats };
    };
    await run(); expect((await run()).actual.processed).toBe(0);
    appendFileSync(paths.get('c')!, usage(4)); await run();
    ids = ['c', 'g', 'u']; await run(); // missing parent restores child-scoped identity
    ids = ['p', 'c', 'g', 'u']; await run();
    write('p', meta('p') + usage(1) + usage(2, 7)); await run();
    write('p', meta('p', 'g') + usage(1)); await run(); // cycle remains conservative
    ids = []; await run();
    ids = ['c', 'p', 'g', 'u']; await run();
    memory = createParsedFileMemory(); hydrateParsedFileMemory(memory, [...saved.values()]); fold = createIncrementalTokenFold();
    await run(); expect((await run()).actual.processed).toBe(0);
  });

  it('matches the full fold through the eight-day v1 upgrade, append and persisted v2 restart', async () => {
    const path = join(dir, 'claude.jsonl');
    const line = (id: string, ts: number, output: number, complete = false) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(),
      requestId: id, message: { id, model: 'fixture', stop_reason: complete ? 'end_turn' : null,
        usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 } } }) + '\n';
    writeFileSync(path, line('old', cutoff - 1, 1) + line('old', cutoff - 1, 90, true)
      + line('new', cutoff, 1) + line('new', cutoff, 20, true));
    const parsed = await parseLogFile(path, claudeTokenReader);
    parsed.v = 1; parsed.entries = parsed.entries.map(({ quality: _quality, ...entry }) => entry);
    let memory = createParsedFileMemory(), fold = createIncrementalTokenFold();
    const info = statSync(path), saved = new Map<string, CachedLogFileSave>();
    hydrateParsedFileMemory(memory, [{ path, size: info.size, mtimeMs: Math.floor(info.mtimeMs), data: packParsedLogFile(parsed) }]);
    const run = async () => {
      fold.begin({});
      await collectTokenEntries({ providerSessions: [{ provider: 'claude', providerSessionId: 's' }],
        readers: [{ ...claudeTokenReader, locate: async () => new Map([['s', [path]]]) }], rootsByProvider: {}, memory,
        refreshSinceMs: cutoff, onSave: (row) => { saved.set(row.path, row); }, onFile: (file) => fold.visit(file) });
      const result = fold.finish();
      const reference = foldTokenEntries(memory.files.get(path)!.parsed.entries.map((entry) => ({ ...entry, provider: 'claude', providerSessionId: 's' })));
      expect(sort(result.rows)).toEqual(sort(reference)); return result;
    };
    // The boundary straddles two dates in UTC; validate totals across every local-day row.
    expect((await run()).rows.reduce((total, row) => total + row.output, 0)).toBe(21);
    appendFileSync(path, line('new', cutoff, 30, true)); expect((await run()).rows.reduce((total, row) => total + row.output, 0)).toBe(31);
    expect((await run()).processed).toBe(0);
    memory = createParsedFileMemory(); hydrateParsedFileMemory(memory, [...saved.values()]); fold = createIncrementalTokenFold();
    expect((await run()).rows.reduce((total, row) => total + row.output, 0)).toBe(31); expect((await run()).processed).toBe(0);
  });

  it('fork cache invalidates only connected components, preserving ambiguous same-scope histories', async () => {
    const make = async (id: string, parent?: string, extra = 0) => {
      const path = join(dir, id + '.jsonl'); writeFileSync(path, meta(id, parent) + usage(1, extra));
      return { path, parsed: await parseLogFile(path, codexTokenReader, undefined, { providerSessionId: id }) };
    };
    const p = await make('p'), c = await make('c', 'p'), u = await make('u');
    const normalize = createCodexForkCache(); const first = normalize([p, c, u]);
    expect(normalize([p, c, u]).get(c.path)).toBe(first.get(c.path));
    const unrelated = await make('u', undefined, 3);
    expect(normalize([p, c, unrelated]).get(c.path)).toBe(first.get(c.path));
    const conflicting = { path: p.path + '.copy', parsed: { ...p.parsed, entries: [{ ...p.parsed.entries[0], input: 777 }] } };
    const files = [c, p, conflicting, unrelated];
    expect(normalize(files)).toEqual(canonicalizeCodexForks(files));
  });
});
