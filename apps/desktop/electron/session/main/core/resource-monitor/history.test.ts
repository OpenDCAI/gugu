import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSnapshot } from '@shared/resource-monitor';
vi.mock('@main/db/client', () => ({ sqlite: {} }));
import { ResourceHistoryStore } from './history';

const connections: Database.Database[] = [];
const directories: string[] = [];
function setup(points = 3, bytes = 100_000, ageMs = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'resource-history-')); directories.push(directory);
  const connection = new Database(join(directory, 'history.db')); connections.push(connection);
  connection.pragma('journal_mode = WAL');
  connection.exec(readFileSync(new URL('../../../drizzle/0038_resource_history.sql', import.meta.url), 'utf8'));
  return { connection, store: new ResourceHistoryStore(connection, { points, bytes, ageMs }) };
}
const sample = (timestamp: number, memory = 20): ResourceSnapshot => ({ timestamp, cpuCount: 1, totalMemoryBytes: 100, runId: 'a', app: { cpuPercent: 2, memoryBytes: memory }, appProcesses: [], entries: [] });
afterEach(() => {
  connections.splice(0).forEach((c) => c.close());
  directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function exported(store: ResourceHistoryStore) {
  let text = '';
  for await (const chunk of store.export()) text += chunk;
  return JSON.parse(text);
}

describe('bounded local resource history', () => {
  it('keeps the newest complete points and survives recreating the store', async () => {
    const { connection, store } = setup();
    const ids = [0, 1, 2, 3, 4].map((at) => store.append(sample(at)));
    expect(store.point(ids[0])).toBeNull();
    expect(store.read().points.map((p) => p.timestamp)).toEqual([2, 3, 4]);
    const reopened = new ResourceHistoryStore(connection);
    expect(reopened.point(ids[4])).toEqual(sample(4));
    expect((await exported(reopened)).samples).toEqual([sample(2), sample(3), sample(4)]);
  });
  it('enforces the age and byte bounds without truncating a process table', () => {
    const size = Buffer.byteLength(JSON.stringify(sample(0)));
    const { store } = setup(100, size * 2, 100);
    store.append(sample(0)); store.append(sample(1)); store.append(sample(2));
    expect(store.read().count).toBe(2);
    expect(store.read().bytes).toBeLessThanOrEqual(size * 2);
    store.append(sample(200));
    expect(store.read().points.map((p) => p.timestamp)).toEqual([200]);
    expect(() => store.append({ ...sample(201), recordingError: 'x'.repeat(size * 3) })).toThrow('exceeds');
    expect(store.read().count).toBe(1);
  });
  it('keeps selectable CPU and memory spikes in a long range, and exports every raw point', async () => {
    const { store } = setup(1000, 1_000_000, 100_000);
    for (let i = 0; i < 901; i++) store.append({ ...sample(i, i === 502 ? 999 : 1), app: { cpuPercent: i === 503 ? 500 : 1, memoryBytes: i === 502 ? 999 : 1 } });
    const history = store.read();
    expect(history.points.length).toBeLessThanOrEqual(600);
    expect(history.points.some((p) => p.cpu === 500)).toBe(true);
    expect(history.points.some((p) => p.memory === 999)).toBe(true);
    expect((await exported(store)).samples).toHaveLength(901);
    store.clear(); expect(store.read().count).toBe(0);
  });
  it('streams one consistent export while recording and eviction continue on the writer', async () => {
    const { store } = setup();
    const snapshots = [sample(1), sample(2), sample(3)];
    snapshots.forEach((value) => store.append(value));
    const stream = store.export();
    // Holding the first chunk must not hold the sampler's connection busy.
    let text = (await stream.next()).value!;
    store.append(sample(4));
    expect(store.read().points.map((p) => p.timestamp)).toEqual([2, 3, 4]);
    for await (const chunk of stream) {
      expect(chunk.length).toBeLessThanOrEqual(JSON.stringify(sample(1)).length + 1);
      text += chunk;
    }
    expect(JSON.parse(text).samples).toEqual(snapshots);
    expect(JSON.parse(text).count).toBe(3);
  });
  it('stores a missing reading as unknown instead of a zero-memory dip', async () => {
    const { store } = setup();
    store.append({ ...sample(1), app: {} });
    expect(store.read().points[0].memory).toBeUndefined();
    expect((await exported(store)).samples[0].app).not.toHaveProperty('memoryBytes');
  });
});
