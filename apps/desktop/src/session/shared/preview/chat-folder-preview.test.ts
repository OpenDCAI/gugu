import { describe, expect, it } from 'vitest';
import { byteRange } from './chat-folder-preview';

describe('byteRange', () => {
  it('reads the one range a media element asks for', () => {
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });
  it('no range is the whole file; a range past the end cannot be met', () => {
    expect(byteRange(null, 100)).toBeNull();
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(byteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
