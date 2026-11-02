import { Worker } from 'node:worker_threads';
import { desktopWorkerPath } from '@main/worker-manifest';
import { log } from '@main/lib/logger';
import { reportServerBoot } from '@gugu/core/cloud/serverBootProgress';
import { parseSearchProgress, type SearchProgress } from '@gugu/core/cloud/serverTransition';
import { resolveDatabasePath } from './path';

let worker: Worker | null = null;
export function startTurnTextBackfillWorker(): void {
  if (worker) return;
  const started = Date.now();
  let progress: SearchProgress = { state: 'running', done: 0, total: 0 };
  let lastLog = 0;
  let failed = false;
  const failure = (error: unknown) => {
    if (failed) return;
    failed = true;
    reportServerBoot({ search: { ...progress, state: 'failed' } });
    log.error('Turn-text backfill worker failed; will resume next start', { error: String(error), elapsedMs: Date.now() - started });
  };
  try {
    const own = new Worker(desktopWorkerPath('turn-text-backfill'), { workerData: { database: resolveDatabasePath() }, name: 'turn-text-backfill' });
    worker = own;
    own.unref();
    log.info('Turn-text backfill started after service readiness');
    own.on('message', (message: { type?: string; progress?: unknown; error?: unknown }) => {
      if (message.type === 'failed') { failure(message.error); return; }
      const next = parseSearchProgress(message.progress);
      if (!next) return;
      progress = next;
      reportServerBoot({ search: progress });
      if (!lastLog || Date.now() - lastLog >= 2_000 || progress.state !== 'running') {
        lastLog = Date.now();
        log.info('Turn-text backfill progress', { ...progress, elapsedMs: lastLog - started });
      }
    });
    own.on('error', failure);
    own.on('exit', code => {
      if (worker !== own) return;
      worker = null;
      if (code !== 0 || progress.state === 'running') failure(`Worker exited before completion (${code})`);
    });
  } catch (error) { failure(error); }
}

export function stopTurnTextBackfillWorker(): void {
  const own = worker; worker = null;
  if (own) void own.terminate();
}
