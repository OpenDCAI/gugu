import { describe, expect, it } from 'vitest';
import { createPieceJoiner, createSeqOrderer, PIECE_CHARS, toPieces } from './session-host-device-frames';

describe('task host frames over the device link', () => {
  it('splits a large frame into pieces and joins it back, binary included', () => {
    const big = 'x'.repeat(PIECE_CHARS * 2 + 10);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const batches = toPieces(['small', big, bytes]);
    const out: Array<string | Uint8Array> = [];
    const join = createPieceJoiner((frame) => out.push(frame));
    for (const batch of batches) join(batch);
    expect(out[0]).toBe('small');
    expect(out[1]).toBe(big);
    expect(Array.from(out[2] as Uint8Array)).toEqual([1, 2, 3, 250]);
    expect(batches.every((batch) => batch.length > 0)).toBe(true);
  });

  it('delivers batches in seq order and drops replays', () => {
    const out: string[] = [];
    const order = createSeqOrderer<string>((item) => out.push(item));
    order(1, 'b');
    order(0, 'a');
    order(0, 'a again');
    order(2, 'c');
    expect(out).toEqual(['a', 'b', 'c']);
  });
});
