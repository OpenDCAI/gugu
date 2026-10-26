import { describe, expect, it } from 'vitest';
import { backgroundWire } from './background-wire';

describe('background bridge JSON transport', () => {
  it('preserves nested file and sync bytes through the actual JSON boundary', () => {
    const value = { files: [{ bytes: Uint8Array.of(0, 255, 8).buffer }], next: null, text: 'hello' };
    const restored = backgroundWire(JSON.parse(JSON.stringify(backgroundWire(value, true))), false);
    expect(restored).toEqual(value);
  });
});
