import { describe, expect, it } from 'vitest';
import { markerWidth } from '../../../../apps/desktop/src/session/renderer/features/sessions/view/session-timeline-geometry';

describe('UI-17 source lengths share the existing lens', () => {
  it('preserves 18px and 8px resting lengths, including outside the lens', () => {
    expect(markerWidth(0, null, 18)).toBe(18);
    expect(markerWidth(0, null, 8)).toBe(8);
    expect(markerWidth(0, 3, 18)).toBe(18);
    expect(markerWidth(0, 3, 8)).toBe(8);
  });

  it('adds the same lens delta to either source and keeps the old default geometry', () => {
    for (const distance of [0, 1, 2, 3]) {
      expect(markerWidth(0, distance, 18) - markerWidth(0, distance, 8)).toBeCloseTo(10);
      expect(markerWidth(0, distance, 18) - 18).toBeCloseTo(markerWidth(0, distance) - 12);
    }
  });
});
