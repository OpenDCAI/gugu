import { describe, expect, it } from 'vitest';
import { diffBodyVisible } from './diff-visibility';

describe('diffBodyVisible', () => {
  it('hides a proposed diff while permission is pending', () => {
    expect(
      diffBodyVisible({ awaitingPermission: true }),
    ).toBe(false);
  });

  it('reveals the diff after the provider reports the permission resolved', () => {
    expect(
      diffBodyVisible({ awaitingPermission: false }),
    ).toBe(true);
  });
});
