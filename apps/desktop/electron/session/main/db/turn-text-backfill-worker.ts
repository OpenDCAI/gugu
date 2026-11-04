import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { runTurnTextBackfill } from './turn-text-backfill-work';

const connection = new Database((workerData as { database: string }).database);
connection.pragma('foreign_keys = ON');
connection.pragma('busy_timeout = 100');
void runTurnTextBackfill(connection, progress => parentPort?.postMessage({ type: 'progress', progress }))
  .catch((error: unknown) => parentPort?.postMessage({ type: 'failed', error: String(error) }))
  .finally(() => { connection.close(); parentPort?.close(); });
