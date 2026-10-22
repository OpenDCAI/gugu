import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSnapshot } from '@shared/resource-monitor';
vi.mock('@main/db/client', () => ({ sqlite: {} }));
import { ResourceHistoryStore } from './history';

const connections: Database.Database[] = [];
function setup(points = 3, bytes = 100_000, ageMs = 1000) {
  const connection = new Database(':memory:'); connections.push(connection);
  connection.exec(readFileSync(new URL('../../../drizzle/0038_resource_history.sql', import.meta.url), 'utf8'));
  return { connection, store: new ResourceHistoryStore(connection, { points, bytes, ageMs }) };
}
const sample = (timestamp: number, memory = 20): ResourceSnapshot => ({ timestamp, cpuCount: 1, totalMemoryBytes: 100, runId: 'a', app: { cpuPercent: 2, memoryBytes: memory }, appProcesses: [], entries: [] });
afterEach(() => connections.splice(0).forEach((c) => c.close()));

describe('bounded local resource history', () => {
  it('keeps the newest complete points, records eviction, and survives recreating the store', () => {
    const { connection, store } = setup();
    const ids = [0, 1, 2, 3, 4].map((at) => store.append(sample(at)));
    expect(store.point(ids[0])).toBeNull();
    expect(store.read().points.map((p) => p.timestamp)).toEqual([2, 3, 4]);
    expect(store.read().discarded).toBe(2);
    const reopened = new ResourceHistoryStore(connection);
    expect(reopened.point(ids[4])).toEqual(sample(4));
    expect(JSON.parse(reopened.export()).samples).toEqual([sample(2), sample(3), sample(4)]);
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
  it('keeps selectable CPU and memory spikes in a long range, and exports every raw point', () => {
    const { store } = setup(1000, 1_000_000, 100_000);
    for (let i = 0; i < 901; i++) store.append({ ...sample(i, i === 502 ? 999 : 1), app: { cpuPercent: i === 503 ? 500 : 1, memoryBytes: i === 502 ? 999 : 1 } });
    const history = store.read();
    expect(history.points.length).toBeLessThanOrEqual(600);
    expect(history.points.some((p) => p.cpu === 500)).toBe(true);
    expect(history.points.some((p) => p.memory === 999)).toBe(true);
    expect(JSON.parse(store.export()).samples).toHaveLength(901);
    store.clear(); expect(store.read().count).toBe(0); expect(store.read().discarded).toBe(0);
  });
  it('filters a process history by run and creation time, rather than merging reused pids', () => {
    const { store } = setup();
    const process = (creationTime: number) => [{ pid: 7, creationTime, type: 'Tab' as const, cpu: 5, memory: 10 }];
    store.append({ ...sample(1), appProcesses: process(1) });
    store.append({ ...sample(2), appProcesses: process(2) });
    store.append({ ...sample(3), runId: 'b', appProcesses: process(1) });
    expect(store.read(0, 100, 7, 'a', 1).points.map((p) => p.timestamp)).toEqual([1]);
    expect(JSON.parse(store.export()).samples).toHaveLength(3);
  });
  it('stores a missing reading as unknown instead of a zero-memory dip', () => {
    const { store } = setup();
    store.append({ ...sample(1), app: { unavailable: 'metrics unavailable' } });
    expect(store.read().points[0].memory).toBeUndefined();
    expect(JSON.parse(store.export()).samples[0].app.unavailable).toBe('metrics unavailable');
    expect(JSON.parse(store.export()).samples[0].app).not.toHaveProperty('memoryBytes');
  });
});
