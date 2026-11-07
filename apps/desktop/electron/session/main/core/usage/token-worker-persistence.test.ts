import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTokenScanService } from './token-scan-worker/service';
import type { FromWorker } from './token-scan-worker/protocol';
import type { TokenCachePager } from './token-scan-client';
import type { CachedLogFileSave } from './token-scan';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'worker-cache-test-')); dirs.push(root);
  mkdirSync(join(root, 'projects', 'synthetic'), { recursive: true });
  const path = join(root, 'projects', 'synthetic', 'session.jsonl');
  const line = (id: string, input = 10) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-07T00:00:00Z', requestId: id, message: { id, model: 'synthetic', usage: { input_tokens: input, output_tokens: 2 } } }) + '\n';
  writeFileSync(path, line('a'));
  const rows = new Map<string, CachedLogFileSave>(); let fail = false;
  const cache: TokenCachePager = {
    loadPage: (after, limit) => [...rows.values()].filter(row => row.path > after).sort((a, b) => a.path < b.path ? -1 : 1).slice(0, limit),
    save(row) { if (fail) throw new Error('synthetic cache failure'); rows.set(row.path, row); },
    checkpoint(persist) { persist(); },
  };
  const messages: FromWorker[] = [];
  const service = () => createTokenScanService(message => messages.push(message), undefined, cache);
  const request = { type: 'scan' as const, id: 1, providerSessions: [{ provider: 'claude', providerSessionId: 'session' }], rootsByProvider: { claude: [root] }, sourcesByProviderSession: {} };
  const last = () => messages.filter(message => message.type === 'result').at(-1)!;
  return { path, line, rows, cache, service, request, messages, last, fail: (value: boolean) => { fail = value; } };
}
it('persists in worker without bulk main messages and hydrates a restarted worker', async () => {
  const r = rig(), service = r.service(); await service.handle(r.request);
  const first = r.last(); expect(first.rows[0].input).toBe(10); expect(r.rows.size).toBe(2);
  expect(r.messages.some(message => message.type === 'save' || message.type === 'prune-cache')).toBe(false);
  await r.service().handle(r.request);
  expect(r.last().rows).toEqual(first.rows); expect(r.last().stats).toMatchObject({ bytesRead: 0, fullParses: 0, cacheHits: 1 });
});
it('keeps parsed usage on cache failure and detects a larger replacement inode', async () => {
  const r = rig(), service = r.service(); r.fail(true); await service.handle(r.request);
  expect(r.last().rows[0].input).toBe(10); expect(r.messages.some(message => message.type === 'cache-error')).toBe(true);
  writeFileSync(r.path + '.new', r.line('new-a', 100) + r.line('new-b', 200)); renameSync(r.path + '.new', r.path);
  r.fail(false); await service.handle(r.request);
  expect(r.last().rows[0].input).toBe(300); expect(r.last().stats.fullParses).toBe(1);
  appendFileSync(r.path, r.line('new-c', 30)); await service.handle(r.request);
  expect(r.last().rows[0].input).toBe(330);
});

it('attempts a failed hydration only once and still scans source logs', async () => {
  const r = rig(); let reads = 0;
  r.cache.loadPage = () => { reads++; throw new Error('synthetic unavailable cache'); };
  const service = r.service(); await service.handle(r.request); await service.handle(r.request);
  expect(reads).toBe(1); expect(r.last().rows[0].input).toBe(10);
  expect(r.messages.filter(message => message.type === 'cache-error')).toHaveLength(1);
});
it('hydrates in bounded pages once across subsequent scans', async () => {
  const r = rig(); const pages: number[] = [];
  for (let i = 0; i < 100; i++) r.rows.set(String(i).padStart(3, '0'), { path: String(i).padStart(3, '0'), size: 1, mtimeMs: 1, provider: 'claude', providerSessionId: 'unused', data: 'invalid cache' });
  const original = r.cache.loadPage;
  r.cache.loadPage = (after, limit) => { pages.push(limit); return original(after, limit); };
  const service = r.service(); await service.handle(r.request); await service.handle(r.request);
  expect(pages).toEqual([40, 40, 40, 40]); expect(r.last().rows[0].input).toBe(10);
});
