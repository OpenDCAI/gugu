import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranscriptAnchorIndex } from './fork-lineage';

const reads = vi.hoisted(() => ({ starts: [] as number[], bytes: 0, hold: null as null | (() => Promise<void>), opened: null as null | (() => void) }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    reads.starts.push(Number((args[1] as { start?: number } | undefined)?.start ?? 0));
    const iterate = stream[Symbol.asyncIterator].bind(stream), hold = reads.hold;
    reads.hold = null;
    stream[Symbol.asyncIterator] = async function* () {
      reads.opened?.();
      if (hold) await hold();
      for await (const chunk of { [Symbol.asyncIterator]: iterate }) {
        reads.bytes += (chunk as Buffer).length;
        yield chunk;
      }
      return undefined;
    };
    return stream;
  } };
});

let root: string;
const line = (uuid: string, compact = false) => JSON.stringify({ uuid, ...(compact ? { subtype: 'compact_boundary' } : {}) }) + '\n';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'anchor-index-')); reads.starts = []; reads.bytes = 0; reads.hold = null; reads.opened = null; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('shares a cold-file read between concurrent callers', async () => {
  const file = path.join(root, 'record.jsonl'), text = line('first') + ('unrelated '.repeat(8192) + '\n').repeat(16) + line('compact', true);
  await writeFile(file, text);
  const index = new TranscriptAnchorIndex();
  const values = await Promise.all([index.anchorsOf(file), index.anchorsOf(file)]);
  expect(values.map(x => [...x])).toEqual([['first', 'compact'], ['first', 'compact']]);
  expect(reads.starts).toEqual([0]);
  expect(reads.bytes).toBe(Buffer.byteLength(text));
  await index.anchorsOf(file);
  expect(reads.starts).toEqual([0]);
});

it('refreshes appended bytes queued behind a read without reading its prefix again', async () => {
  const file = path.join(root, 'record.jsonl'), initial = line('first'), added = line('later', true);
  await writeFile(file, initial);
  const gate = deferred(), opened = deferred(); reads.hold = () => gate.promise; reads.opened = opened.resolve;
  const index = new TranscriptAnchorIndex(), first = index.anchorsOf(file);
  await opened.promise;
  await appendFile(file, added);
  const second = index.anchorsOf(file); gate.resolve();
  await first; expect(await second).toEqual(new Set(['first', 'later']));
  expect(reads.starts).toEqual([0, Buffer.byteLength(initial)]);
  expect(reads.bytes).toBe(Buffer.byteLength(initial + added));
});

it('does not block another file behind an in-flight read', async () => {
  const a = path.join(root, 'a.jsonl'), b = path.join(root, 'b.jsonl'); await writeFile(a, line('a')); await writeFile(b, line('b'));
  const gate = deferred(), opened = deferred(); reads.hold = () => gate.promise; reads.opened = opened.resolve;
  const index = new TranscriptAnchorIndex(), first = index.anchorsOf(a); await opened.promise;
  try { expect(await index.anchorsOf(b)).toEqual(new Set(['b'])); } finally { gate.resolve(); await first; }
});

it('releases the queue after a read error and preserves truncation handling', async () => {
  const file = path.join(root, 'record.jsonl'); await writeFile(file, line('long-first-name') + line('compact', true));
  const index = new TranscriptAnchorIndex(); await index.anchorsOf(file);
  await writeFile(file, line('new')); expect(await index.anchorsOf(file)).toEqual(new Set(['new']));
  await rm(file); expect(await index.anchorsOf(file)).toEqual(new Set());
  await writeFile(file, line('reborn') + line('reborn-compact', true));
  // A missing file does not throw; an invalid path does, and must not poison the queue.
  const invalid = file + '/invalid';
  await expect(index.anchorsOf(invalid)).rejects.toThrow();
  expect(await index.anchorsOf(file)).toContain('reborn-compact');
  await rm(file); await mkdir(file); await writeFile(invalid, line('retry'));
  expect(await index.anchorsOf(invalid)).toEqual(new Set(['retry']));
});
