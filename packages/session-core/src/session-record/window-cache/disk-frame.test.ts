import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWindowFrame, writeWindowFrame } from './disk-frame.ts';
import { encodeWindowFrame, windowFrameName, type WindowFrameKey } from './frame.ts';
import { openWindowByteSource } from './file-source.ts';
import { readBytePage } from './byte-page.ts';

const key: WindowFrameKey = {
  sessionId: 'session-one', provider: 'codex', sourceId: 'a'.repeat(64), generation: 'b'.repeat(64),
  decoderVersion: 1, kind: 'window', cursor: 'offset:600000000'
};
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-window-frame-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('atomic disk frames and pinned native sources (#2062)', () => {
  it('publishes a complete frame and leaves no temporary files', async () => {
    const directory = await fixture();
    expect(await readWindowFrame(directory, key)).toEqual({ kind: 'miss', reason: 'not_found' });
    await writeWindowFrame(directory, key, Buffer.from('tail'));
    const result = await readWindowFrame(directory, key);
    expect(result.kind === 'hit' && Buffer.from(result.bytes).toString()).toBe('tail');
    expect(await readdir(directory)).toEqual([windowFrameName(key)]);
  });

  it('ignores an interrupted unpublished write and rebuilds from a typed miss for corrupt data', async () => {
    const directory = await fixture();
    await writeFile(join(directory, `${windowFrameName(key)}.interrupted.tmp`), 'partial');
    expect(await readWindowFrame(directory, key)).toEqual({ kind: 'miss', reason: 'not_found' });
    await writeFile(join(directory, windowFrameName(key)), 'corrupt');
    expect(await readWindowFrame(directory, key)).toEqual({ kind: 'miss', reason: 'format' });
    await writeWindowFrame(directory, key, Buffer.from('rebuilt'));
    const result = await readWindowFrame(directory, key);
    expect(result.kind === 'hit' && Buffer.from(result.bytes).toString()).toBe('rebuilt');
  });

  it('does not publish one generation under another generation key', async () => {
    const directory = await fixture();
    const next = { ...key, generation: 'c'.repeat(64) };
    await Promise.all([writeWindowFrame(directory, key, Buffer.from('old')), writeWindowFrame(directory, next, Buffer.from('new'))]);
    expect((await readWindowFrame(directory, key)).kind).toBe('hit');
    expect((await readWindowFrame(directory, next)).kind).toBe('hit');
    await writeFile(join(directory, windowFrameName(next)), encodeWindowFrame(key, Buffer.from('old')));
    expect(await readWindowFrame(directory, next)).toEqual({ kind: 'miss', reason: 'key' });
  });

  it('detects checksum corruption on the actual disk read path', async () => {
    const directory = await fixture();
    await writeWindowFrame(directory, key, Buffer.from('tail'));
    const path = join(directory, windowFrameName(key));
    const packet = await readFile(path);
    packet[packet.length - 1] ^= 1;
    await writeFile(path, packet);
    expect(await readWindowFrame(directory, key)).toEqual({ kind: 'miss', reason: 'checksum' });
  });

  it('makes a cache I/O failure observable instead of throwing into a conversation read', async () => {
    const directory = await fixture();
    const regularFile = join(directory, 'file');
    await writeFile(regularFile, 'not a directory');
    const result = await readWindowFrame(regularFile, key);
    expect(result.kind === 'miss' && result.reason).toBe('io');
    expect(result.kind === 'miss' && result.error).toBeInstanceOf(Error);
  });

  it('reads a real pinned file and resets a cursor after a same-size rewrite', async () => {
    const directory = await fixture();
    const path = join(directory, 'native.jsonl');
    await writeFile(path, 'one\ntwo');
    const source = await openWindowByteSource(path);
    try {
      const before = await source.snapshot();
      const first = await readBytePage(source);
      expect(first.kind === 'page' && Buffer.from(first.bytes).toString()).toBe('one\ntwo');
      await writeFile(path, 'new\nrow');
      expect(await readBytePage(source, { cursor: { generation: before.generation, before: 7 } })).toEqual({ kind: 'reset', reason: 'source_changed' });
    } finally { await source.close(); }
  });

  it('detects pathname replacement even though the original descriptor is still readable', async () => {
    const directory = await fixture();
    const path = join(directory, 'native.jsonl');
    const replacement = join(directory, 'replacement.jsonl');
    await writeFile(path, 'old');
    const source = await openWindowByteSource(path);
    try {
      await source.snapshot();
      await writeFile(replacement, 'new');
      await rename(replacement, path);
      await expect(readBytePage(source)).rejects.toThrow('replaced');
    } finally { await source.close(); }
  });
});
