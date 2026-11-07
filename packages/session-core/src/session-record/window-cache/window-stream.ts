import { randomUUID } from 'node:crypto';
import { WINDOW_FRAME_BYTES } from './byte-page.ts';
import { readWindowFrame, writeWindowFrame } from './disk-frame.ts';
import { windowFrameName, type WindowFrameKey, type WindowFrameRead } from './frame.ts';

export type WindowStreamKey = Omit<WindowFrameKey, 'kind'>;
export type WindowStreamRoot = {
  version: 1;
  binding: string;
  publication: string;
  frameCount: number;
  byteLength: number;
};
export type WindowStreamRootRead =
  | { kind: 'hit'; root: WindowStreamRoot }
  | Extract<WindowFrameRead, { kind: 'miss' }>;

function frameKey(key: WindowStreamKey, root: WindowStreamRoot, index: number): WindowFrameKey {
  return { ...key, kind: 'window', cursor: `${root.publication}:${index}` };
}

function rootBinding(key: WindowStreamKey): string {
  return windowFrameName({ ...key, kind: 'index' }).slice(0, 64);
}

function validRoot(root: WindowStreamRoot): boolean {
  return !!root && root.version === 1 && typeof root.binding === 'string' &&
    /^[a-f0-9]{64}$/.test(root.binding) && typeof root.publication === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(root.publication) &&
    Number.isSafeInteger(root.frameCount) && root.frameCount >= 0 &&
    Number.isSafeInteger(root.byteLength) && root.byteLength >= 0 &&
    root.frameCount === Math.ceil(root.byteLength / WINDOW_FRAME_BYTES);
}

/**
 * Stream into bounded immutable frames, then publish one constant-size root.
 * The worker producer owns decoding/spilling; this function never accepts a whole timeline object.
 * Old roots remain valid during a concurrent publication because every write has its own namespace.
 */
export async function writeWindowStream(
  directory: string,
  key: WindowStreamKey,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<WindowStreamRoot> {
  const root: WindowStreamRoot = { version: 1, binding: rootBinding(key), publication: randomUUID(), frameCount: 0, byteLength: 0 };
  const pending = new Uint8Array(WINDOW_FRAME_BYTES);
  let used = 0;
  const flush = async () => {
    signal?.throwIfAborted();
    await writeWindowFrame(directory, frameKey(key, root, root.frameCount), pending.subarray(0, used));
    root.frameCount += 1;
    root.byteLength += used;
    used = 0;
  };
  signal?.throwIfAborted();
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    for (let offset = 0; offset < chunk.byteLength;) {
      const take = Math.min(WINDOW_FRAME_BYTES - used, chunk.byteLength - offset);
      pending.set(chunk.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used === WINDOW_FRAME_BYTES) await flush();
    }
  }
  if (used) await flush();
  // The root contains counts and a publication namespace, never an array of all frames.
  signal?.throwIfAborted();
  await writeWindowFrame(directory, { ...key, kind: 'index' }, Buffer.from(JSON.stringify(root)));
  return root;
}

export async function readWindowStreamRoot(directory: string, key: WindowStreamKey): Promise<WindowStreamRootRead> {
  const frame = await readWindowFrame(directory, { ...key, kind: 'index' });
  if (frame.kind === 'miss') return frame;
  let root: WindowStreamRoot;
  try { root = JSON.parse(Buffer.from(frame.bytes).toString('utf8')) as WindowStreamRoot; }
  catch { return { kind: 'miss', reason: 'format' }; }
  if (!validRoot(root)) return { kind: 'miss', reason: 'format' };
  if (root.binding !== rootBinding(key)) return { kind: 'miss', reason: 'key' };
  return { kind: 'hit', root };
}

/** Read the tail (default) or an older frame without loading any other payload or a history-sized manifest. */
export async function readWindowStreamPage(
  directory: string,
  key: WindowStreamKey,
  root: WindowStreamRoot,
  index = root.frameCount - 1
): Promise<WindowFrameRead> {
  if (!validRoot(root)) return { kind: 'miss', reason: 'format' };
  if (root.binding !== rootBinding(key)) return { kind: 'miss', reason: 'key' };
  if (root.frameCount === 0 && index === -1 && root.byteLength === 0) return { kind: 'hit', bytes: new Uint8Array() };
  if (!Number.isSafeInteger(index) || index < 0 || index >= root.frameCount) throw new Error('Invalid window frame cursor');
  const result = await readWindowFrame(directory, frameKey(key, root, index));
  if (result.kind === 'miss') return result;
  const expected = index === root.frameCount - 1 ? root.byteLength - index * WINDOW_FRAME_BYTES : WINDOW_FRAME_BYTES;
  return result.bytes.length === expected ? result : { kind: 'miss', reason: 'format' };
}
