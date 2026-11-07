import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInProcessTokenScanWorker } from './_support/in-process-worker';
import { createTokenScanClient, type TokenCachePager } from './token-scan-client';
import { tokenCachePartRange, TOKEN_CACHE_PART_ENTRIES } from './token-file-cache';
import type { CachedLogFileSave } from './token-scan';
import { createTokenScanService } from './token-scan-worker/service';
import { claudeTokenReader } from './token-readers/claude';
import type { FromWorker } from './token-scan-worker/protocol';
import type { TokenLogReader } from './token-readers/types';
import type { SourceSpans } from './model-source';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gugu-token-incremental-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const line = (id: string, input = 10) => JSON.stringify({ type: 'assistant', timestamp: '2026-09-23T10:00:00Z', requestId: id,
  message: { id, model: 'fixture', usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } } }) + '\n';

function rig(lines = line('first')) {
  const home = join(dir, 'claude'), project = join(home, 'projects', 'fixture'); mkdirSync(project, { recursive: true });
  const path = join(project, 'session.jsonl'); writeFileSync(path, lines);
  const rows = new Map<string, CachedLogFileSave>(); let saves = 0, failedHeads = false, errors = 0;
  const cache: TokenCachePager = {
    loadPage: (after, limit) => [...rows.values()].filter((r) => r.path > after).sort((a, b) => a.path < b.path ? -1 : 1).slice(0, limit),
    save: (row) => { saves += 1; if (failedHeads && row.path === path) throw new Error('synthetic interrupted checkpoint'); rows.set(row.path, row); },
    prune: (file, generation) => {
      const all = tokenCachePartRange(file), keep = tokenCachePartRange(file, generation);
      for (const key of rows.keys()) if (key >= all.start && key < all.end && !(key >= keep.start && key < keep.end)) rows.delete(key);
    },
  };
  const makeClient = () => createTokenScanClient({ cache, spawn: createInProcessTokenScanWorker, onSaveError: () => { errors += 1; } });
  const request = { providerSessions: [{ provider: 'claude', providerSessionId: 'session' }], rootsByProvider: { claude: [home] }, sourcesByProviderSession: {} as Record<string, SourceSpans> };
  return { path, rows, request, makeClient, saves: () => saves, errors: () => errors, failHeads: (value: boolean) => { failedHeads = value; } };
}

describe('incremental token scan through the client', () => {
  it('unchanged hot scan folds zero entries and saves nothing; append only folds the new line', async () => {
    const r = rig(Array.from({ length: 1200 }, (_, i) => line(String(i))).join('')), client = r.makeClient();
    try {
      const first = await client.scan(r.request), writes = r.saves();
      const hot = await client.scan(r.request);
      expect(hot.stats).toMatchObject({ cacheHits: 1, bytesRead: 0, foldedEntries: 0 });
      expect(r.saves()).toBe(writes); expect(hot.rows).toEqual(first.rows);
      const extra = line('next'); appendFileSync(r.path, extra);
      const changed = await client.scan(r.request);
      expect(changed.stats).toMatchObject({ resumed: 1, bytesRead: Buffer.byteLength(extra), foldedEntries: 1 });
      expect(changed.stats.cacheWriteEntries).toBeLessThanOrEqual(TOKEN_CACHE_PART_ENTRIES + 1);
      expect(changed.rows[0].input).toBe(12010);
      await client.dispose();
      const restarted = await client.scan(r.request);
      expect(restarted.stats).toMatchObject({ cacheHits: 1, bytesRead: 0 });
      expect(restarted.rows).toEqual(changed.rows);
    } finally { await client.dispose(); }
  });

  it('truncation, same-size rewrite and replacement inode replace only that file contribution', async () => {
    const r = rig(line('first') + line('second')), client = r.makeClient();
    try {
      await client.scan(r.request);
      writeFileSync(r.path, line('short', 5)); utimesSync(r.path, new Date(), new Date(Date.now() + 2000));
      expect((await client.scan(r.request)).rows[0].input).toBe(5);
      writeFileSync(r.path, line('short', 8)); utimesSync(r.path, new Date(), new Date(Date.now() + 4000));
      expect((await client.scan(r.request)).rows[0].input).toBe(8);
      writeFileSync(r.path + '.new', line('replacement', 15) + line('other', 20)); renameSync(r.path + '.new', r.path);
      const replaced = await client.scan(r.request);
      expect(replaced.stats.fullParses).toBe(1); expect(replaced.rows[0].input).toBe(35);
      unlinkSync(r.path); expect((await client.scan(r.request)).rows).toEqual([]);
      writeFileSync(r.path, line('back', 3)); expect((await client.scan(r.request)).rows[0].input).toBe(3);
      expect(r.rows.size).toBe(2); // superseded chunk generations were pruned
    } finally { await client.dispose(); }
  });

  it('a failed checkpoint remains correct in memory and reparses after restart instead of using a torn tail', async () => {
    const r = rig(), client = r.makeClient();
    try {
      await client.scan(r.request); r.failHeads(true); appendFileSync(r.path, line('new'));
      const result = await client.scan(r.request); expect(result.rows[0].input).toBe(20); expect(r.errors()).toBe(1);
      await client.dispose(); r.failHeads(false);
      const rebuilt = await client.scan(r.request);
      expect(rebuilt.stats.fullParses).toBe(1); expect(rebuilt.rows).toEqual(result.rows);
    } finally { await client.dispose(); }
  });

  it('source changes reclassify cached winners without log IO or cache writes', async () => {
    const r = rig(), client = r.makeClient();
    try {
      await client.scan(r.request); const writes = r.saves();
      r.request.sourcesByProviderSession.session = { fallback: 'byok', spans: [] };
      const result = await client.scan(r.request);
      expect(result.rows[0]).toMatchObject({ input: 10, source: 'byok' });
      expect(result.stats.bytesRead).toBe(0); expect(r.saves()).toBe(writes);
    } finally { await client.dispose(); }
  });
  it('Codex case aliases read one file once and keep cumulative deltas and first-source ownership', async () => {
    const r = rig(), client = r.makeClient();
    const sid = '01a0ce35-43e0-7db2-b762-49dd6f882b08', upper = sid.toUpperCase();
    const root = join(dir, 'codex'), day = join(root, 'sessions', '2026', '09', '23'); mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-09-23T10-00-00-${sid}.jsonl`);
    const count = (minute: string, input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', timestamp: `2026-09-23T10:${minute}:00Z`,
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } }) + '\n';
    writeFileSync(path, count('01', 1000, 100, 10));
    const request = { providerSessions: [{ provider: 'codex', providerSessionId: upper }, { provider: 'codex', providerSessionId: sid }], rootsByProvider: { codex: [root] },
      sourcesByProviderSession: { [upper]: { fallback: 'gugu', spans: [] }, [sid]: { fallback: 'byok', spans: [] } } as Record<string, SourceSpans> };
    try {
      const first = await client.scan(request); expect(first.stats.files).toBe(1); expect(first.rows[0]).toMatchObject({ input: 900, cacheRead: 100, source: 'gugu' });
      appendFileSync(path, count('02', 1500, 200, 20));
      const changed = await client.scan(request); expect(changed.stats.resumed).toBe(1);
      expect(changed.rows[0]).toMatchObject({ input: 1300, cacheRead: 200, output: 20 });
      request.providerSessions = [{ provider: 'codex', providerSessionId: sid }];
      const scoped = await client.scan(request); expect(scoped.rows[0]).toMatchObject({ input: 1300, source: 'byok' });
    } finally { await client.dispose(); }
  });

  it('a later reader failure resets partial aggregates; retry can revert the source and reuse parsed memory', async () => {
    const r = rig(), messages: FromWorker[] = []; let fail = false;
    const broken: TokenLogReader = { provider: 'broken', initialState: () => null, mayCarryUsage: () => false, readLine: () => null,
      locate: async () => { if (fail) throw new Error('synthetic directory failure'); return new Map(); } };
    const service = createTokenScanService((message) => messages.push(message), [claudeTokenReader, broken]);
    r.request.providerSessions.push({ provider: 'broken', providerSessionId: 'unused' });
    await service.handle({ type: 'scan', id: 1, ...r.request });
    appendFileSync(r.path, line('appended')); fail = true;
    r.request.sourcesByProviderSession.session = { fallback: 'byok', spans: [] };
    await service.handle({ type: 'scan', id: 2, ...r.request });
    expect(messages.at(-1)?.type).toBe('failed');
    fail = false; r.request.sourcesByProviderSession = {};
    await service.handle({ type: 'scan', id: 3, ...r.request });
    const result = messages.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type !== 'result') throw new Error('missing retry result');
    expect(result.rows).toHaveLength(1); expect(result.rows[0]).toMatchObject({ input: 20, source: null });
    expect(result.stats.bytesRead).toBe(0);
  });

});
