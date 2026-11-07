import { createHash, timingSafeEqual } from 'node:crypto';
import { WINDOW_FRAME_BYTES } from './byte-page.ts';

const MAGIC = Buffer.from('GUGUWIN1');
const HEADER_BYTES = 48;
const META_BYTES = 4096;
export const MAX_WINDOW_FILE_BYTES = HEADER_BYTES + META_BYTES + WINDOW_FRAME_BYTES;

export type WindowFrameKey = {
  sessionId: string;
  provider: string;
  sourceId: string;
  generation: string;
  decoderVersion: number;
  kind: 'window' | 'checkpoint' | 'index';
  cursor: string;
};

export type WindowFrameRead =
  | { kind: 'hit'; bytes: Uint8Array }
  | { kind: 'miss'; reason: 'format' | 'checksum' | 'key' | 'not_found' | 'io'; error?: unknown };

/** Validate before JSON encoding: even the metadata cannot become a history-sized object. */
function canonicalKey(key: WindowFrameKey): string {
  if (typeof key.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.sessionId) ||
      typeof key.provider !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(key.provider) ||
      typeof key.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(key.sourceId) ||
      typeof key.generation !== 'string' || !/^[a-f0-9]{64}$/.test(key.generation) ||
      !Number.isSafeInteger(key.decoderVersion) || key.decoderVersion < 1 ||
      !['window', 'checkpoint', 'index'].includes(key.kind) ||
      typeof key.cursor !== 'string' || key.cursor.length > 256) {
    throw new Error('Invalid window frame key');
  }
  return JSON.stringify({
    version: 1, sessionId: key.sessionId, provider: key.provider, sourceId: key.sourceId,
    generation: key.generation, decoderVersion: key.decoderVersion, kind: key.kind, cursor: key.cursor
  });
}

export function windowFrameName(key: WindowFrameKey): string {
  return `${createHash('sha256').update(canonicalKey(key)).digest('hex')}.frame`;
}

export function encodeWindowFrame(key: WindowFrameKey, bytes: Uint8Array): Buffer {
  if (bytes.byteLength > WINDOW_FRAME_BYTES) throw new Error('Window payload must be split into frames');
  const meta = Buffer.from(canonicalKey(key), 'utf8');
  if (meta.length > META_BYTES) throw new Error('Window metadata exceeds frame schema');
  const packet = Buffer.alloc(HEADER_BYTES + meta.length + bytes.byteLength);
  MAGIC.copy(packet);
  packet.writeUInt32BE(meta.length, 8);
  packet.writeUInt32BE(bytes.byteLength, 12);
  meta.copy(packet, HEADER_BYTES);
  packet.set(bytes, HEADER_BYTES + meta.length);
  createHash('sha256').update(packet.subarray(HEADER_BYTES)).digest().copy(packet, 16);
  return packet;
}

/** A checksum is integrity only. The caller must validate the source generation before publishing a hit. */
export function decodeWindowFrame(expected: WindowFrameKey, packet: Uint8Array): WindowFrameRead {
  const wanted = canonicalKey(expected);
  if (packet.byteLength < HEADER_BYTES || packet.byteLength > MAX_WINDOW_FILE_BYTES) return { kind: 'miss', reason: 'format' };
  const buffer = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  if (!buffer.subarray(0, 8).equals(MAGIC)) return { kind: 'miss', reason: 'format' };
  const metaLength = buffer.readUInt32BE(8);
  const payloadLength = buffer.readUInt32BE(12);
  if (metaLength > META_BYTES || payloadLength > WINDOW_FRAME_BYTES || HEADER_BYTES + metaLength + payloadLength !== buffer.length) {
    return { kind: 'miss', reason: 'format' };
  }
  const digest = createHash('sha256').update(buffer.subarray(HEADER_BYTES)).digest();
  if (!timingSafeEqual(digest, buffer.subarray(16, HEADER_BYTES))) return { kind: 'miss', reason: 'checksum' };
  // Exact canonical bytes validate the schema/version as well as session/provider/generation/cursor ownership.
  if (buffer.toString('utf8', HEADER_BYTES, HEADER_BYTES + metaLength) !== wanted) return { kind: 'miss', reason: 'key' };
  return { kind: 'hit', bytes: buffer.subarray(HEADER_BYTES + metaLength) };
}
