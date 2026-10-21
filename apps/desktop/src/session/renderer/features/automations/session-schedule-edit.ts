import { format } from 'date-fns';
import type { TriggerConfig } from '@shared/core/automations/config';

// 人在任务页上给 agent 排的那条改时间(owner 10-19 A):只改时间,交代仍归 agent。这里是「改成什么」的纯函数,
// 判「能不能这样改」的是主进程(repo.updateAutomationSettings:一次性要在一分钟以后、cron 要算得出下一次)。

/** `<input type="datetime-local">` 认的那种本地时间串。 */
export function toLocalInputValue(at: number): string {
  return format(at, "yyyy-MM-dd'T'HH:mm");
}

/** 反过来;读不出 = null(输入框被清空)。 */
export function fromLocalInputValue(value: string): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? null : at;
}

/**
 * 重复的那条哪一种能只改「几点」:`分 时 * * 星期`(每天 / 工作日 / 每周某天)。别的(隔几分钟、每月几号…)= null,
 * 改的是整条规则。
 */
export function timeOfDayOf(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dayOfMonth !== '*' || month !== '*') return null;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** 只换「几点」,星期那一段原样。时刻填空了或不完整 = null(保存钮灰着,❌ 拼出一条 NaN 的 cron 再让主进程拒)。 */
export function withTimeOfDay(expr: string, time: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const parts = expr.trim().split(/\s+/);
  return [String(Number(match[2])), String(Number(match[1])), ...parts.slice(2)].join(' ');
}

/** 一次性改到某一刻;tz 原样留着(只给人看)。 */
export function oneTimeTrigger(trigger: TriggerConfig, at: number): TriggerConfig {
  return { expr: '', ...(trigger.tz ? { tz: trigger.tz } : {}), at };
}

/** 重复的改规则;tz 原样。 */
export function cronTrigger(trigger: TriggerConfig, expr: string): TriggerConfig {
  return { expr: expr.trim(), ...(trigger.tz ? { tz: trigger.tz } : {}) };
}

/** 明早 9 点(本地):快捷键之一。 */
export function tomorrowNine(now = Date.now()): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}
