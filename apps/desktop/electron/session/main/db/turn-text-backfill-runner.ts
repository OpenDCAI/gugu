import { Worker } from 'node:worker_threads';
import { desktopWorkerPath } from '@main/worker-manifest';
import type { SearchBackfillProgress } from '@shared/core/search';
import { parseSearchBackfillProgress, setSearchBackfillProgress } from './search-backfill-state';
import { resolveDatabasePath } from './path';

export type SearchBackfillLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};
let worker: Worker | null = null;
export function startTurnTextBackfillWorker(log: SearchBackfillLogger): void {
  if (worker) return;
  const started = Date.now();
  let progress: SearchBackfillProgress = { state: 'running', done: 0, total: 0 };
  let lastLog = 0;
  let failed = false;
  const failure = (error: unknown) => {
    if (failed) return;
    failed = true;
    setSearchBackfillProgress({ ...progress, state: 'failed' });
    log.error({ error: String(error), elapsedMs: Date.now() - started }, 'Search backfill failed; will resume next start');
  };
  try {
    const own = new Worker(desktopWorkerPath('turn-text-backfill'), { workerData: { database: resolveDatabasePath() }, name: 'turn-text-backfill' });
    worker = own;
    setSearchBackfillProgress(progress);
    log.info({}, 'Search backfill started after service readiness');
    own.on('message', (message: { type?: string; progress?: unknown; error?: unknown }) => {
      if (message.type === 'failed') { failure(message.error); return; }
      const next = parseSearchBackfillProgress(message.progress);
      if (!next) return;
      progress = next;
      setSearchBackfillProgress(progress);
      if (!lastLog || Date.now() - lastLog >= 2_000 || progress.state !== 'running') {
        lastLog = Date.now();
        log.info({ ...progress, elapsedMs: lastLog - started }, 'Search backfill progress');
      }
    });
    own.on('error', failure);
    own.on('exit', code => {
      if (worker !== own) return;
      worker = null;
      if (code !== 0 || progress.state === 'running') failure(`Worker exited before completion (${code})`);
    });
    own.unref();
  } catch (error) { failure(error); }
}

export function stopTurnTextBackfillWorker(): void {
  const own = worker; worker = null;
  if (own) void own.terminate();
}
