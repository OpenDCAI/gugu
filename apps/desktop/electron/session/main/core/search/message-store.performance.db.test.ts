import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem';
import type { SearchQuery } from '@gugu/core/shared/search/types';
import { MessageSearchStore } from './message-store';

// Opt-in measurement, never a timing threshold or an ordinary CI load test.
// GUGU_SEARCH_PERF=1 GUGU_SEARCH_PERF_OUTPUT=<new absolute jsonl> pnpm exec vitest run
//   --project session-main-db apps/desktop/electron/session/main/core/search/message-store.performance.db.test.ts
it.skipIf(process.env.GUGU_SEARCH_PERF !== '1')('records 100k-row store query samples, p95 and physical file sizes', () => {
  const output = process.env.GUGU_SEARCH_PERF_OUTPUT;
  if (!output || !isAbsolute(output)) throw new Error('GUGU_SEARCH_PERF_OUTPUT must name a new absolute JSONL file');
  const fd = openSync(output, 'wx', 0o600);
  const record = (row: object) => { writeSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); };
  let root: string | undefined;
  let store: MessageSearchStore | undefined;
  const files = () => ['', '-wal', '-shm'].map((suffix) => ({
    suffix: suffix || '.sqlite', bytes: store && existsSync(store.path + suffix) ? statSync(store.path + suffix).size : 0,
  }));
  try {
    record({ phase: 'start', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      pid: process.pid, cwd: process.cwd(), node: process.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      requestedRows: 100_000, warmupsPerQuery: 3, samplesPerQuery: 20 });
    console.log('Search store performance evidence opened:', output);
    root = mkdtempSync(join(tmpdir(), 'gugu-search-a7-perf-'));
    store = new MessageSearchStore(root, 'performance-account');
    const chats = Array.from({ length: 8 }, (_, i) => ({ id: `chat-${i}`, kind: 'group' as const, sourceChatId: null }));
    store.apply([{ kind: 'chats', chats }]);
    const emptyFields = Object.fromEntries(MESSAGES_VIEW_SELECT.split(', ').map((field) => [field, null]));
    const fixtureStarted = performance.now();
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const rows: RawMessageRow[] = Array.from({ length: 1000 }, (_, index) => {
        const i = offset + index;
        return { ...emptyFields, id: `message-${i}`, chat_id: `chat-${i % 8}`, sender_user_id: `sender-${i % 4}`,
          seq: i + 1, content: `发布计划 benchmark ${i}${i % 1000 === 0 ? ' performanceunique' : ''}`,
          content_type: 'text', created_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), is_whisper: false };
      });
      store.apply([{ kind: 'rows', rows }]);
    }
    const db = new Database(store.path, { readonly: true });
    try {
      expect((db.prepare('SELECT count(*) AS n FROM msg').get() as { n: number }).n).toBe(100_000);
      expect((db.prepare("SELECT count(*) AS n FROM msg_fts WHERE msg_fts MATCH 'benchmark'").get() as { n: number }).n).toBe(100_000);
    } finally { db.close(); }
    record({ phase: 'fixture', actualRows: 100_000, setupMs: performance.now() - fixtureStarted, files: files() });
    const cases: { name: string; query: SearchQuery }[] = [
      { name: 'cjk-recent', query: { text: '发布', filters: {}, sort: 'recent' } },
      { name: 'rare-token', query: { text: 'performanceunique', filters: {}, sort: 'recent' } },
      { name: 'scoped-chat', query: { text: '发布', filters: { in: [{ kind: 'chat', id: 'chat-0' }] }, sort: 'recent' } },
      { name: 'negative-relevant', query: { text: '发布 -performanceunique', filters: {}, sort: 'relevant' } },
      { name: 'date-only', query: { text: '', filters: { on: '2026-10-01' }, sort: 'recent' } },
      { name: 'latin-prefix', query: { text: 'bench', filters: {}, sort: 'relevant' } },
    ];
    for (const { name, query } of cases) {
      const request = { query, limit: 50 };
      for (let i = 0; i < 3; i++) store.global(request);
      const samplesMs: number[] = [];
      for (let sample = 0; sample < 20; sample++) {
        const started = performance.now();
        const result = store.global(request);
        const elapsedMs = performance.now() - started;
        samplesMs.push(elapsedMs);
        record({ phase: 'sample', name, sample, elapsedMs, resultIds: result.results.map((hit) => hit.id) });
        expect(result.results.length).toBeGreaterThan(0);
      }
      const sorted = [...samplesMs].sort((a, b) => a - b);
      const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
      record({ phase: 'query-summary', name, query, samplesMs, p95Ms });
      console.log(JSON.stringify({ name, p95Ms, sampleCount: samplesMs.length }));
    }
    store.close();
    record({ phase: 'complete', actualRows: 100_000, filesAfterClose: files() });
  } catch (error) {
    record({ phase: 'error', message: String(error) });
    throw error;
  } finally {
    try {
      store?.close();
      if (root) {
        console.log('Removing own performance fixture:', root);
        rmSync(root, { recursive: true, force: true });
        record({ phase: 'cleanup', fixtureRemoved: !existsSync(root) });
      }
    } finally { closeSync(fd); }
  }
}, 300_000);
