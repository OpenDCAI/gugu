import { describe, expect, it } from 'vitest';
import { decodeWindowFrame, encodeWindowFrame, windowFrameName, type WindowFrameKey } from './frame.ts';
import { WINDOW_FRAME_BYTES } from './byte-page.ts';

const frameKey: WindowFrameKey = {
  sessionId: 'session-one', provider: 'codex', sourceId: 'a'.repeat(64), generation: 'b'.repeat(64),
  decoderVersion: 1, kind: 'window', cursor: 'offset:600000000'
};

describe('validated window frames (#2062)', () => {
  it('round trips binary payload bytes without parsing a historical JSON object', () => {
    const bytes = Buffer.from('中文\n{"incomplete":');
    const frame = encodeWindowFrame(frameKey, bytes);
    const result = decodeWindowFrame(frameKey, frame);
    expect(result.kind === 'hit' && Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(windowFrameName(frameKey)).toMatch(/^[a-f0-9]{64}\.frame$/);
  });

  it.each(['sessionId', 'provider', 'generation', 'sourceId', 'decoderVersion', 'kind', 'cursor'] as const)('rejects a valid frame owned by another %s', field => {
    const other = {
      ...frameKey,
      [field]: field === 'decoderVersion' ? 2 : field === 'kind' ? 'checkpoint' : field === 'generation' || field === 'sourceId' ? 'c'.repeat(64) : 'other'
    } as WindowFrameKey;
    expect(decodeWindowFrame(other, encodeWindowFrame(frameKey, Buffer.from('tail')))).toEqual({ kind: 'miss', reason: 'key' });
    expect(windowFrameName(other)).not.toBe(windowFrameName(frameKey));
  });

  it('rejects payload and metadata corruption, truncated files, trailing bytes and another format version', () => {
    const frame = encodeWindowFrame(frameKey, Buffer.from('tail'));
    const corrupt = Buffer.from(frame);
    corrupt[corrupt.length - 1] ^= 1;
    expect(decodeWindowFrame(frameKey, corrupt)).toEqual({ kind: 'miss', reason: 'checksum' });
    const metadata = Buffer.from(frame);
    metadata[50] ^= 1;
    expect(decodeWindowFrame(frameKey, metadata)).toEqual({ kind: 'miss', reason: 'checksum' });
    expect(decodeWindowFrame(frameKey, frame.subarray(0, frame.length - 1))).toEqual({ kind: 'miss', reason: 'format' });
    expect(decodeWindowFrame(frameKey, Buffer.concat([frame, Buffer.from('x')]))).toEqual({ kind: 'miss', reason: 'format' });
    const version = Buffer.from(frame);
    version[7] = 50;
    expect(decodeWindowFrame(frameKey, version)).toEqual({ kind: 'miss', reason: 'format' });
  });

  it('enforces the frame budget before encoding, without admitting a whole large archive', () => {
    expect(() => encodeWindowFrame(frameKey, new Uint8Array(WINDOW_FRAME_BYTES + 1))).toThrow('split');
    expect(() => encodeWindowFrame({ ...frameKey, cursor: 'x'.repeat(257) }, new Uint8Array())).toThrow('key');
    expect(decodeWindowFrame(frameKey, encodeWindowFrame(frameKey, new Uint8Array(WINDOW_FRAME_BYTES))).kind).toBe('hit');
  });

  it('owns its payload while computing a digest', () => {
    const input = Buffer.from('tail');
    const frame = encodeWindowFrame(frameKey, input);
    input.fill(0);
    const result = decodeWindowFrame(frameKey, frame);
    expect(result.kind === 'hit' && Buffer.from(result.bytes).toString()).toBe('tail');
  });
});
