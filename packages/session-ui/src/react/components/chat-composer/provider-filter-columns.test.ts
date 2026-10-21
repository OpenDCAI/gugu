import { describe, expect, it } from 'vitest';
import { providerFilterColumns } from './composer-model-menu';

// 厂商过滤条等分成格(owner 2026-10-10:「按钮块的大小能保持一致」)。一行最多四格,多了按行均分 ——
// 不留一格孤零零挂在下一行。
describe('providerFilterColumns —— 每行几格', () => {
  it('四家以内一行排完', () => {
    expect([2, 3, 4].map(providerFilterColumns)).toEqual([2, 3, 4]);
  });

  it('多出来的按行均分:5 → 3+2,6 → 3+3,7 → 4+3,9 → 3+3+3,10 → 4+4+2', () => {
    expect([5, 6, 7, 8, 9, 10].map(providerFilterColumns)).toEqual([3, 3, 4, 4, 3, 4]);
  });
});
