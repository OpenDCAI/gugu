import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { TranscriptAnchorIndex } from './fork-lineage';

const failure = vi.hoisted(() => ({ calls: 0, failCall: 1, prefixRead: () => {}, release: Promise.resolve() }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    if (++failure.calls !== failure.failCall) return stream;
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      const part = await iterate().next();
      if (part.done) throw new Error('expected fixture bytes');
      yield (part.value as Buffer).subarray(0, 8);
      failure.prefixRead();
      await failure.release;
      throw Object.assign(new Error('partial read failed'), { code: 'EIO' });
    };
    return stream;
  } };
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
for (const warm of [false, true]) {
  it(`rolls back a partial-line failure before the queued retry (warm=${warm})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'anchor-failure-')), file = path.join(root, 'record.jsonl');
    const firstLine = '{"uuid":"root"}\n', compact = '{"uuid":"compact","subtype":"compact_boundary"}\n';
    await writeFile(file, firstLine + (warm ? '' : compact));
    const prefixRead = deferred(), release = deferred();
    failure.calls = 0; failure.failCall = warm ? 2 : 1; failure.prefixRead = prefixRead.resolve; failure.release = release.promise;
    const index = new TranscriptAnchorIndex();
    if (warm) { expect(await index.anchorsOf(file)).toEqual(new Set(['root'])); await appendFile(file, compact); }
    const first = index.anchorsOf(file).catch(error => error);
    await prefixRead.promise;
    const second = index.anchorsOf(file); release.resolve();
    try {
      expect(await first).toMatchObject({ code: 'EIO' });
      expect(await second).toEqual(new Set(['root', 'compact']));
      expect(await index.anchorsOf(file)).toEqual(new Set(['root', 'compact']));
    } finally {
      release.resolve(); await first; await second.catch(() => {}); await rm(root, { recursive: true, force: true });
    }
  });
}
