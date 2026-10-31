import type { FileHandle } from 'node:fs/promises';

/** Frame envelopes only; Node zlib remains the decompressor. RFC 8878 §§3.1.1–3.1.2. */
export async function* zstdFrames(file: FileHandle, size: number): AsyncGenerator<{ start: number; end: number; contentSize: bigint | null }> {
  let offset = 0;
  const skip = (bytes: number) => {
    if (offset + bytes > size) throw new Error('Truncated zstd snapshot');
    offset += bytes;
  };
  const read = async (bytes: number) => {
    const start = offset;
    skip(bytes);
    const buffer = Buffer.alloc(bytes);
    let filled = 0;
    while (filled < bytes) {
      const { bytesRead } = await file.read(buffer, filled, bytes - filled, start + filled);
      if (!bytesRead) throw new Error('Truncated zstd snapshot');
      filled += bytesRead;
    }
    return buffer;
  };
  while (offset < size) {
    const start = offset;
    const magic = (await read(4)).readUInt32LE();
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      skip((await read(4)).readUInt32LE());
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid zstd frame magic');
    const descriptor = (await read(1))[0];
    if (descriptor & 8) throw new Error('Reserved zstd frame flag');
    const single = !!(descriptor & 32);
    if (!single) skip(1); // window descriptor
    skip([0, 1, 2, 4][descriptor & 3]); // dictionary ID
    const sizeFlag = descriptor >>> 6;
    const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
    const bytes = await read(sizeBytes);
    const contentSize = sizeBytes === 0 ? null : sizeBytes === 8 ? bytes.readBigUInt64LE()
      : BigInt(bytes.readUIntLE(0, sizeBytes) + (sizeBytes === 2 ? 256 : 0));
    let last: boolean;
    do {
      const block = (await read(3)).readUIntLE(0, 3);
      last = !!(block & 1);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('Reserved zstd block type');
      skip(type === 1 ? 1 : block >>> 3); // RLE has one encoded byte; raw/compressed blocks carry Block_Size bytes.
    } while (!last);
    if (descriptor & 4) skip(4); // checksum, verified by Node zlib
    yield { start, end: offset - 1, contentSize };
  }
}
