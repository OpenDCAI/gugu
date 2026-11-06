import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { describe, expect, it, vi } from 'vitest';
import { nextPartBytes, SMALLEST_PART_BYTES, uploadInParts } from './working-copy-upload';

describe('a part stays about a second long on whatever line it is', () => {
  it('doubles while quick, up to the largest; halves when long, down to the smallest; holds between', () => {
    expect(nextPartBytes(SMALLEST_PART_BYTES, 100)).toBe(SMALLEST_PART_BYTES * 2);
    expect(nextPartBytes(REMOTE_WORKSPACE_CHUNK_BYTES, 100)).toBe(REMOTE_WORKSPACE_CHUNK_BYTES);
    expect(nextPartBytes(SMALLEST_PART_BYTES * 4, 5000)).toBe(SMALLEST_PART_BYTES * 2);
    expect(nextPartBytes(SMALLEST_PART_BYTES, 5000)).toBe(SMALLEST_PART_BYTES);
    expect(nextPartBytes(SMALLEST_PART_BYTES * 2, 900)).toBe(SMALLEST_PART_BYTES * 2);
  });

  it('a file goes whole, in order, however its parts were sized, starting from the smallest', async () => {
    const bytes = new Uint8Array(1_000_000).map((_, at) => at % 251);
    const got: Uint8Array[] = [];
    const offsets: number[] = [];
    const write = vi.fn(async (part: { offset: number; data: string; final: boolean }) => {
      offsets.push(part.offset);
      got.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)));
      return { received: 0, ...(part.final ? { entry: { id: 'f' } as never } : {}) };
    });
    const entries = await uploadInParts(write, { workspace: 'session:s' } as never, [{ name: 'f', blob: new Blob([bytes]) }], undefined);
    expect(entries).toHaveLength(1);
    expect(offsets[1]).toBe(SMALLEST_PART_BYTES);
    expect(Buffer.concat(got).equals(Buffer.from(bytes))).toBe(true);
  });
});
