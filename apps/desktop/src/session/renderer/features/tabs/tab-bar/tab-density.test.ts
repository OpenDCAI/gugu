import { describe, expect, it } from 'vitest';
import { TAB_COMPACT_MAX_PX, TAB_ICON_MAX_PX, tabDensity } from './tab-density';

describe('how a tab gives way as it narrows (Chrome / VS Code shrink)', () => {
  it('full → compact → icon as the width drops; unmeasured stays full', () => {
    expect(tabDensity(0, true)).toBe('full');
    expect(tabDensity(200, true)).toBe('full');
    expect(tabDensity(TAB_COMPACT_MAX_PX + 1, true)).toBe('full');
    expect(tabDensity(TAB_COMPACT_MAX_PX, true)).toBe('compact');
    expect(tabDensity(TAB_ICON_MAX_PX + 1, true)).toBe('compact');
    expect(tabDensity(TAB_ICON_MAX_PX, true)).toBe('icon');
  });

  it('a tab without an icon never goes icon-only (it would be blank)', () => {
    expect(tabDensity(40, false)).toBe('compact');
  });
});
