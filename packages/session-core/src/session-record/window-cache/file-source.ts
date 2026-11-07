import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import type { WindowByteSource } from './byte-page.ts';

/** Pin the descriptor, and also check the path: fstat alone misses atomic pathname replacement. */
export async function openWindowByteSource(path: string): Promise<WindowByteSource & { close(): Promise<void> }> {
  const canonical = await realpath(path);
  const file = await open(canonical, 'r');
  const sourceId = createHash('sha256').update(canonical).digest('hex');
  return {
    async snapshot() {
      const descriptor = await file.stat({ bigint: true });
      const named = await stat(path, { bigint: true });
      const fingerprint = (info: typeof descriptor) =>
        `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (!descriptor.isFile() || fingerprint(descriptor) !== fingerprint(named)) {
        throw new Error('Native record source was replaced');
      }
      if (descriptor.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Native record offset is not representable');
      return {
        sourceId,
        generation: createHash('sha256').update(sourceId).update(fingerprint(descriptor)).digest('hex'),
        size: Number(descriptor.size)
      };
    },
    async read(target, offset, length, position) {
      return (await file.read(target, offset, length, position)).bytesRead;
    },
    close: () => file.close()
  };
}
