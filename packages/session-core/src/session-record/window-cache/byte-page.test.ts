import { describe, expect, it, vi } from 'vitest';
import { readBytePage, WINDOW_FRAME_BYTES, type SourceSnapshot, type WindowByteSource } from './byte-page.ts';

const generation = 'a'.repeat(64);
const sourceId = 'b'.repeat(64);

function virtualSource(size: number) {
  const snapshot = vi.fn(async (): Promise<SourceSnapshot> => ({ size, generation, sourceId }));
  const read = vi.fn(async (target: Uint8Array, offset: number, length: number, _position: number) => {
    target.fill(120, offset, offset + length);
    return length;
  });
  return { snapshot, read } satisfies WindowByteSource;
}

describe('bounded native byte pages (#2062)', () => {
  it.each([10, 30, 100, 600])('reads one tail frame at a virtual %s MiB offset without reading the prefix', async mib => {
    const size = mib * 1024 * 1024;
    const source = virtualSource(size);
    const page = await readBytePage(source);
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') throw new Error('Expected a byte page');
    expect(page.bytes.length).toBe(WINDOW_FRAME_BYTES);
    expect(source.read.mock.calls.map(([, , length, position]) => [length, position])).toEqual([[WINDOW_FRAME_BYTES, size - WINDOW_FRAME_BYTES]]);
    expect(page.older).toEqual({ generation, before: size - WINDOW_FRAME_BYTES });
    const previous = await readBytePage(source, { cursor: page.older! });
    expect(previous.kind === 'page' && previous.end).toBe(page.start);
    expect(source.snapshot).toHaveBeenCalledTimes(4);
  });

  it('does not read anything for an obsolete generation', async () => {
    const source = virtualSource(100);
    expect(await readBytePage(source, { cursor: { generation: 'old', before: 50 } })).toEqual({ kind: 'reset', reason: 'source_changed' });
    expect(source.read).not.toHaveBeenCalled();
  });

  it.each(['append', 'rewrite', 'replacement'])('does not publish bytes if a concurrent %s changes the snapshot', async change => {
    const source = virtualSource(100);
    source.snapshot.mockResolvedValueOnce({ size: 100, generation, sourceId });
    source.snapshot.mockResolvedValue({
      size: change === 'append' ? 101 : 100,
      generation: change === 'rewrite' ? 'c'.repeat(64) : generation,
      sourceId: change === 'replacement' ? 'd'.repeat(64) : sourceId
    });
    expect(await readBytePage(source)).toEqual({ kind: 'reset', reason: 'source_changed' });
  });

  it('fills short reads using exact byte offsets and keeps an unterminated record intact', async () => {
    const bytes = Buffer.from('中文\n{"partial":');
    const source = virtualSource(bytes.length);
    source.read.mockImplementation(async (target, offset, length, position) => {
      const count = Math.min(2, length);
      target.set(bytes.subarray(position, position + count), offset);
      return count;
    });
    const result = await readBytePage(source);
    expect(result.kind === 'page' && Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(result.kind === 'page' && result.older).toBeNull();
    expect(source.read.mock.calls.map(([, , , position]) => position)).toEqual(Array.from({ length: Math.ceil(bytes.length / 2) }, (_, i) => i * 2));
  });

  it('does not turn a short file or a source error into a successful empty page', async () => {
    const source = virtualSource(100);
    source.read.mockResolvedValue(0);
    expect(await readBytePage(source)).toEqual({ kind: 'reset', reason: 'source_changed' });
    source.read.mockRejectedValue(new Error('EACCES'));
    await expect(readBytePage(source)).rejects.toThrow('EACCES');
  });

  it('checks cancellation before I/O and after an in-flight read', async () => {
    const source = virtualSource(100);
    const before = new AbortController();
    before.abort();
    await expect(readBytePage(source, { signal: before.signal })).rejects.toThrow();
    expect(source.snapshot).not.toHaveBeenCalled();
    const during = new AbortController();
    source.read.mockImplementation(async () => { during.abort(); return 100; });
    await expect(readBytePage(source, { signal: during.signal })).rejects.toThrow();
    expect(source.snapshot).toHaveBeenCalledTimes(1);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid cursor %s instead of allocating from it', async before => {
    const source = virtualSource(100);
    await expect(readBytePage(source, { cursor: { generation, before } })).rejects.toThrow('cursor');
    expect(source.read).not.toHaveBeenCalled();
  });

  it('returns an empty, current source as an empty page with no earlier cursor', async () => {
    const source = virtualSource(0);
    const page = await readBytePage(source);
    expect(page.kind === 'page' && [page.bytes.length, page.older]).toEqual([0, null]);
    expect(source.read).not.toHaveBeenCalled();
  });
});
