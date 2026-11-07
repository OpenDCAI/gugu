import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeWindowFrame, encodeWindowFrame, MAX_WINDOW_FILE_BYTES, windowFrameName,
  type WindowFrameKey, type WindowFrameRead
} from './frame.ts';

/** Worker-owned derived data. The directory is supplied by the host's isolated cache namespace. */
export async function readWindowFrame(directory: string, key: WindowFrameKey): Promise<WindowFrameRead> {
  const path = join(directory, windowFrameName(key));
  try {
    const file = await open(path, 'r');
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_WINDOW_FILE_BYTES) return { kind: 'miss', reason: 'format' };
      const packet = new Uint8Array(before.size);
      let offset = 0;
      while (offset < packet.length) {
        const { bytesRead } = await file.read(packet, offset, packet.length - offset, offset);
        if (!bytesRead) return { kind: 'miss', reason: 'format' };
        offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        return { kind: 'miss', reason: 'format' };
      }
      return decodeWindowFrame(key, packet);
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'miss', reason: 'not_found' }
      : { kind: 'miss', reason: 'io', error };
  }
}

/** Concurrent generations have distinct immutable names. No whole-history manifest is constructed here. */
export async function writeWindowFrame(directory: string, key: WindowFrameKey, bytes: Uint8Array): Promise<void> {
  const packet = encodeWindowFrame(key, bytes);
  const path = join(directory, windowFrameName(key));
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(packet);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
