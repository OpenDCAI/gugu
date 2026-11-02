import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  unref = vi.fn(); terminate = vi.fn(async () => 1);
  constructor(readonly file: string, readonly options: unknown) { super(); mocks.workers.push(this); }
} }));
vi.mock('@main/worker-manifest', () => ({ desktopWorkerPath: () => '/build/turn-text-backfill.js' }));
vi.mock('./path', () => ({ resolveDatabasePath: () => '/isolated/history.db' }));

const { startTurnTextBackfillWorker, stopTurnTextBackfillWorker } = await import('./turn-text-backfill-runner');
afterEach(() => { stopTurnTextBackfillWorker(); mocks.workers.length = 0; vi.useRealTimers(); });
const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('post-ready backfill worker boundary', () => {
  it('spawns once and sends measured progress to the host logger, including completion', () => {
    vi.useFakeTimers();
    const log = logger(); startTurnTextBackfillWorker(log); startTurnTextBackfillWorker(log);
    expect(mocks.workers).toHaveLength(1);
    const worker = mocks.workers[0]!;
    expect(worker.file).toBe('/build/turn-text-backfill.js');
    expect(worker.options).toMatchObject({ workerData: { database: '/isolated/history.db' } });
    worker.emit('message', { type: 'progress', progress: { state: 'running', done: 42, total: 100 } });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ done: 42, total: 100 }), 'Search backfill progress');
    worker.emit('message', { type: 'progress', progress: { state: 'complete', done: 100, total: 100 } });
    worker.emit('exit', 0);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ state: 'complete', done: 100 }), 'Search backfill progress');
    expect(log.error).not.toHaveBeenCalled();
  });
  it('reports a failed worker without throwing into the host, and ignores termination during host shutdown', () => {
    const log = logger(); startTurnTextBackfillWorker(log);
    mocks.workers[0]!.emit('error', new Error('disk refused'));
    expect(log.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: 'Error: disk refused' }), expect.any(String));
    stopTurnTextBackfillWorker(); mocks.workers[0]!.emit('exit', 1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
