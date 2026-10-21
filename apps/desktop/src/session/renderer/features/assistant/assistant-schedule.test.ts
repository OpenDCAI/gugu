import { describe, expect, it } from 'vitest';
import { assistantRoutines, scheduleText, simpleSchedule, weekdayName } from './assistant-schedule';

describe('simpleSchedule', () => {
  it('每天 / 周一至周五 / 每周某天说成人话,时间补零', () => {
    expect(simpleSchedule('0 8 * * *')).toEqual({ every: 'day', time: '08:00' });
    expect(simpleSchedule('30 9 * * 1-5')).toEqual({ every: 'weekday', time: '09:30' });
    expect(simpleSchedule('0 18 * * 1')).toEqual({ every: 'week', time: '18:00', weekday: 1 });
    expect(simpleSchedule('0 18 * * 7')).toEqual({ every: 'week', time: '18:00', weekday: 0 });
  });

  it('别的形状不硬套(交给 cronstrue)', () => {
    for (const expr of ['*/5 * * * *', '0 8 1 * *', '0 8 * 1 *', '0 8 * * 1,3', '0 25 * * *', '', null, '0 8 * *']) {
      expect(simpleSchedule(expr), String(expr)).toBeNull();
    }
  });
});

describe('weekdayName', () => {
  it('0 是周日,按语言给名字', () => {
    expect(weekdayName(0, 'en-US')).toBe('Sunday');
    expect(weekdayName(1, 'zh-CN')).toBe('星期一');
  });
});

describe('scheduleText / assistantRoutines(桌面与手机共用)', () => {
  const t = (key: string, options?: Record<string, unknown>) => `${key}${options ? JSON.stringify(options) : ''}`;
  it('一次性的说那一刻,常见 cron 说成人话,认不出的交给 cronstrue,再不行原样给 cron', () => {
    expect(scheduleText({ triggerConfig: { at: 1_760_000_000_000 } as never }, 'zh-CN', () => '10月9日 16:53', t)).toBe('10月9日 16:53');
    expect(scheduleText({ triggerConfig: { expr: '0 8 * * *' } as never }, 'zh-CN', () => '', t)).toBe('routines.everyDay{"time":"08:00"}');
    expect(scheduleText({ triggerConfig: { expr: '*/15 * * * *' } as never }, 'en', () => '', t)).toMatch(/15 minutes/);
    expect(scheduleText({ triggerConfig: { expr: 'not a cron' } as never }, 'en', () => '', t)).toBe('not a cron');
    expect(scheduleText({}, 'en', () => '', t)).toBe('');
  });

  it('只要它给自己排的;建它的会话认不出身份时算它的;人建的(没有 agentSessionId)不算;新的在前', () => {
    const a = (id: string, agentSessionId: string | undefined, createdAt: number) => ({ id, agentSessionId, createdAt });
    const agentOf = new Map<string, string | null>([
      ['s-mine', 'assistant'],
      ['s-other', 'other-agent'],
      ['s-anon', null],
    ]);
    const routines = assistantRoutines([a('mine', 's-mine', 1), a('other', 's-other', 2), a('human', undefined, 3), a('unknown', 's-unlisted', 4), a('anon', 's-anon', 5)], agentOf, 'assistant');
    expect(routines.map((r) => r.id)).toEqual(['anon', 'unknown', 'mine']);
  });
});
