import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime } from './absolute-time-format';

// #7221 云电脑验收:中文界面的「上次运行于」写成了「Oct 15, 07:07」。
describe('formatAbsoluteTime', () => {
  const at = new Date(2026, 9, 15, 7, 7);
  const now = new Date(2026, 9, 15, 8, 0);

  it('中文界面:10月15日 07:07,没有英文月份', () => {
    expect(formatAbsoluteTime(at, 'zh-CN', { now })).toBe('10月15日 07:07');
  });

  it('中文界面跨年 / 要求带年份:带上年', () => {
    expect(formatAbsoluteTime(at, 'zh-CN', { now: new Date(2027, 0, 2) })).toBe('2026年10月15日 07:07');
    expect(formatAbsoluteTime(at, 'zh', { now, includeYear: true })).toBe('2026年10月15日 07:07');
  });

  it('英文界面:月份缩写,时刻跟 locale 的 12 小时制', () => {
    expect(formatAbsoluteTime(at, 'en', { now })).toBe('Oct 15, 07:07 AM');
  });
});
