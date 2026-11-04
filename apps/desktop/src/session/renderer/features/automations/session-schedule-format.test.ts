import { describe, expect, it } from 'vitest';
import { zhCNMessages } from '@renderer/localization/messages';
import { formatScheduleWhen, scheduleMissText, scheduleRuleText } from './session-schedule-format';

const translate = (key: string, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    (zhCNMessages as Record<string, string>)[key] ?? `<missing ${key}>`
  );

// 本地时间拼出来的时刻:测的是「今天 / 明天 / 日期」按本地日历日分,❌ 依赖跑测试那台机器的时区。
const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();

describe('formatScheduleWhen', () => {
  it('今天、一小时内:带还有几分钟', () => {
    expect(formatScheduleWhen(new Date(2026, 9, 19, 10, 30).getTime(), 'zh-CN', translate, NOW)).toBe('今天 10:30（30 分钟后）');
  });
  it('今天、一小时以后:只写时刻', () => {
    expect(formatScheduleWhen(new Date(2026, 9, 19, 15, 0).getTime(), 'zh-CN', translate, NOW)).toBe('今天 15:00');
  });
  it('明天', () => {
    expect(formatScheduleWhen(new Date(2026, 9, 20, 9, 30).getTime(), 'zh-CN', translate, NOW)).toBe('明天 09:30');
  });
  it('再远带日期(与「已安排」页同一个写法)', () => {
    expect(formatScheduleWhen(new Date(2026, 9, 21, 9, 0).getTime(), 'zh-CN', translate, NOW)).toBe('10月21日 09:00');
  });
  it('exactly one hour is outside the positive less-than-one-hour window', () => {
    expect(formatScheduleWhen(NOW + 3_600_000, 'zh-CN', translate, NOW)).toBe('今天 11:00');
    expect(formatScheduleWhen(NOW, 'zh-CN', translate, NOW)).toBe('今天 10:00');
  });
  it('已经过去的(没送到的那一次)不说「还有几分钟」', () => {
    expect(formatScheduleWhen(new Date(2026, 9, 19, 9, 50).getTime(), 'zh-CN', translate, NOW)).toBe('今天 09:50');
  });
});

describe('scheduleRuleText / scheduleMissText', () => {
  it('一次性没有规则;重复的说成人话', () => {
    expect(scheduleRuleText({ expr: '', at: NOW }, 'zh-CN')).toBeNull();
    expect(scheduleRuleText({ expr: '0 9 * * 1-5' }, 'zh-CN')).toMatch(/09:00/);
  });
  it('认得的原因各一句,认不出的只说没送到 / 错过了(❌ 原因码进文案)', () => {
    expect(scheduleMissText('missed', 'deadline_exceeded', '今天 09:00', translate)).toBe('今天 09:00 错过了：这台机器当时没开');
    expect(scheduleMissText('failed', 'interrupted_by_restart', '今天 09:00', translate)).toBe('今天 09:00 没送到：当时咕咕重启了');
    expect(scheduleMissText('failed', 'delivery_failed', '今天 09:00', translate)).toBe('今天 09:00 没送到');
    expect(scheduleMissText('missed', undefined, '今天 09:00', translate)).toBe('今天 09:00 错过了');
  });
});
