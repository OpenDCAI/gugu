// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isStripOverflowing, readStripTabs, wheelToHorizontal } from './tab-overflow';

describe('a tab strip with more tabs than fit (VS Code: scroll + "show opened editors")', () => {
  it('knows when it overflows', () => {
    expect(isStripOverflowing({ scrollWidth: 500, clientWidth: 500 })).toBe(false);
    expect(isStripOverflowing({ scrollWidth: 501, clientWidth: 500 })).toBe(false);
    expect(isStripOverflowing({ scrollWidth: 620, clientWidth: 500 })).toBe(true);
  });

  it('turns a vertical wheel into horizontal scrolling, leaves trackpad sideways swipes alone', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 40 })).toBe(40);
    expect(wheelToHorizontal({ deltaX: 30, deltaY: 10 })).toBeNull();
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 0 })).toBeNull();
  });

  it('lists the tabs in strip order with their names', () => {
    document.body.innerHTML = `
      <div id="strip">
        <div data-tabid="a" data-tab-label="文件" title="文件"></div>
        <div data-tabid="b" data-tab-label="notes.md" title="notes.md (preview)" data-tab-active=""></div>
      </div>`;
    expect(readStripTabs(document.getElementById('strip')!)).toEqual([
      { tabId: 'a', label: '文件', isActive: false },
      { tabId: 'b', label: 'notes.md', isActive: true },
    ]);
  });
});
