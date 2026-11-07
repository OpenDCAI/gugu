import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOW_FRAME_BYTES } from './byte-page.ts';
import { readWindowFrame, writeWindowFrame } from './disk-frame.ts';
import { readWindowStreamPage, readWindowStreamRoot, writeWindowStream, type WindowStreamKey } from './window-stream.ts';

const key: WindowStreamKey = {
  sessionId: 'session-one', provider: 'codex', sourceId: 'a'.repeat(64), generation: 'b'.repeat(64),
  decoderVersion: 1, cursor: 'newest-window'
};
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-window-stream-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function* chunks(bytes: Uint8Array[]) { yield* bytes; }

describe('streaming window cache (#2062)', () => {
  it('stores a larger window as frames and reads its tail without reopening all frames', async () => {
    const directory = await fixture();
    const body = new Uint8Array(WINDOW_FRAME_BYTES * 2 + 19).fill(120);
    const root = await writeWindowStream(directory, key, chunks([body.subarray(0, 7), body.subarray(7)]));
    expect(root.frameCount).toBe(3);
    expect(root.byteLength).toBe(body.length);
    expect((await readdir(directory)).filter(name => name.endsWith('.frame'))).toHaveLength(4);
    expect(await readWindowStreamRoot(directory, key)).toEqual({ kind: 'hit', root });
    const tail = await readWindowStreamPage(directory, key, root);
    expect(tail.kind === 'hit' && tail.bytes.length).toBe(19);
    const first = await readWindowStreamPage(directory, key, root, 0);
    expect(first.kind === 'hit' && first.bytes.length).toBe(WINDOW_FRAME_BYTES);
    const manifest = await readWindowFrame(directory, { ...key, kind: 'index' });
    expect(manifest.kind === 'hit' && manifest.bytes.length).toBeLessThan(512);
  });

  it('retains the previous root and its data when a producer fails after a frame was written', async () => {
    const directory = await fixture();
    const previous = await writeWindowStream(directory, key, chunks([Buffer.from('previous')]));
    async function* failure() { yield new Uint8Array(WINDOW_FRAME_BYTES); throw new Error('decoder failed'); }
    await expect(writeWindowStream(directory, key, failure())).rejects.toThrow('decoder failed');
    expect(await readWindowStreamRoot(directory, key)).toEqual({ kind: 'hit', root: previous });
    const page = await readWindowStreamPage(directory, key, previous);
    expect(page.kind === 'hit' && Buffer.from(page.bytes).toString()).toBe('previous');
  });

  it('pins old frames across a newer publication without mixing the two windows', async () => {
    const directory = await fixture();
    const previous = await writeWindowStream(directory, key, chunks([Buffer.from('previous')]));
    const current = await writeWindowStream(directory, key, chunks([Buffer.from('current')]));
    expect(current.publication).not.toBe(previous.publication);
    expect(await readWindowStreamRoot(directory, key)).toEqual({ kind: 'hit', root: current });
    const oldPage = await readWindowStreamPage(directory, key, previous);
    const newPage = await readWindowStreamPage(directory, key, current);
    expect(oldPage.kind === 'hit' && Buffer.from(oldPage.bytes).toString()).toBe('previous');
    expect(newPage.kind === 'hit' && Buffer.from(newPage.bytes).toString()).toBe('current');
  });

  it('leaves the previous root visible on cancellation', async () => {
    const directory = await fixture();
    const previous = await writeWindowStream(directory, key, chunks([Buffer.from('previous')]));
    const controller = new AbortController();
    async function* cancelled() { yield new Uint8Array(WINDOW_FRAME_BYTES); controller.abort(); yield Buffer.from('tail'); }
    await expect(writeWindowStream(directory, key, cancelled(), controller.signal)).rejects.toThrow();
    expect(await readWindowStreamRoot(directory, key)).toEqual({ kind: 'hit', root: previous });
  });

  it('rejects invalid root versions and a valid-checksum root with inconsistent counts', async () => {
    const directory = await fixture();
    for (const root of [
      { version: 2, publication: 'a'.repeat(36), frameCount: 0, byteLength: 0 },
      { version: 1, publication: 'a'.repeat(36), frameCount: 2, byteLength: 1 },
      null
    ]) {
      await writeWindowFrame(directory, { ...key, kind: 'index' }, Buffer.from(JSON.stringify(root)));
      expect(await readWindowStreamRoot(directory, key)).toEqual({ kind: 'miss', reason: 'format' });
    }
  });

  it('publishes and reads an empty source without inventing an older frame', async () => {
    const directory = await fixture();
    const root = await writeWindowStream(directory, key, chunks([]));
    expect(root.frameCount).toBe(0);
    expect(await readWindowStreamPage(directory, key, root)).toEqual({ kind: 'hit', bytes: new Uint8Array() });
    expect(await readWindowStreamPage(directory, { ...key, generation: 'c'.repeat(64) }, root)).toEqual({ kind: 'miss', reason: 'key' });
  });
});
