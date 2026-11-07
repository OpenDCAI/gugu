/** Worker-side byte primitive for #2062. It does not decode an arbitrary suffix as a complete turn. */
export const WINDOW_FRAME_BYTES = 64 * 1024;

export type SourceSnapshot = {
  sourceId: string;
  generation: string;
  size: number;
};

export type BytePageCursor = { generation: string; before: number };

export interface WindowByteSource {
  snapshot(): Promise<SourceSnapshot>;
  read(target: Uint8Array, offset: number, length: number, position: number): Promise<number>;
}

export type BytePageResult =
  | { kind: 'reset'; reason: 'source_changed' }
  | {
      kind: 'page';
      snapshot: SourceSnapshot;
      start: number;
      end: number;
      bytes: Uint8Array;
      older: BytePageCursor | null;
    };

/** Exactly one bounded byte page. Partial JSON/UTF-8 belongs to the incremental decoder, not this layer. */
export async function readBytePage(
  source: WindowByteSource,
  options: { cursor?: BytePageCursor; signal?: AbortSignal } = {}
): Promise<BytePageResult> {
  const { signal, cursor } = options;
  signal?.throwIfAborted();
  const initial = await source.snapshot();
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(initial.size) || initial.size < 0) throw new Error('Invalid source size');
  if (cursor && cursor.generation !== initial.generation) return { kind: 'reset', reason: 'source_changed' };
  const end = cursor?.before ?? initial.size;
  if (!Number.isSafeInteger(end) || end < 0 || end > initial.size) throw new Error('Invalid byte-page cursor');
  const start = Math.max(0, end - WINDOW_FRAME_BYTES);
  const bytes = new Uint8Array(end - start);
  let read = 0;
  while (read < bytes.length) {
    signal?.throwIfAborted();
    const count = await source.read(bytes, read, bytes.length - read, start + read);
    signal?.throwIfAborted();
    if (!Number.isInteger(count) || count < 0 || count > bytes.length - read) throw new Error('Invalid source read length');
    if (count === 0) return { kind: 'reset', reason: 'source_changed' };
    read += count;
  }
  const final = await source.snapshot();
  signal?.throwIfAborted();
  if (final.sourceId !== initial.sourceId || final.generation !== initial.generation || final.size !== initial.size) {
    return { kind: 'reset', reason: 'source_changed' };
  }
  return {
    kind: 'page', snapshot: initial, start, end, bytes,
    older: start > 0 ? { generation: initial.generation, before: start } : null
  };
}
