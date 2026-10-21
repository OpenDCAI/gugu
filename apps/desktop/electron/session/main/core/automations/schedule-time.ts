import { Cron } from 'croner';
import type { TriggerConfig } from '@shared/core/automations/config';
import { getLocalTimeZone } from '@shared/core/automations/timezone';
import { assertValidCronTrigger } from '@shared/core/automations/validation';

/**
 * #7221 一次性的最早能排多近。调度器 60 秒扫一次,云电脑管家提前 2 分钟叫醒;不足一分钟的排上了也只会晚到,
 * 所以当场拒绝、说清楚,❌ 收下再悄悄晚一分钟。
 */
export const MIN_ONE_TIME_LEAD_MS = 60_000;

/** ISO 8601 日期时间,秒与时区偏移可省;省了偏移就按 `tz` 算。 */
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;

export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`tz: unknown time zone "${tz}" — pass an IANA name such as Asia/Shanghai`);
  }
}

/** 一刻 → 「2026-10-16 08:00 Asia/Shanghai」:在那个时区里读的日期与时刻,带上时区名。 */
export function describeScheduleTime(at: number, tz: string | undefined): string {
  const zone = tz || getLocalTimeZone();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${zone}`;
}

/**
 * agent 给的时间 → 存下来的触发配置。`at` 一次性、`cron` 重复,二选一;`tz` 缺省是这台机器的时区
 * (与它收到的投递信封里的时间同一个钟)。每种错都当场说清改成什么样。
 */
export function resolveScheduleTrigger(
  input: { at?: string; cron?: string; tz?: string },
  now = Date.now()
): TriggerConfig {
  const tz = input.tz?.trim() || getLocalTimeZone();
  assertTimeZone(tz);
  const at = input.at?.trim();
  const cron = input.cron?.trim();
  if (!!at === !!cron) throw new Error('pass exactly one of at (one time) or cron (repeating)');

  if (cron) {
    try {
      assertValidCronTrigger({ expr: cron, tz });
    } catch {
      throw new Error(
        `cron: "${cron}" is not a 5-field cron expression (minute hour day-of-month month day-of-week) — e.g. "0 8 * * *" is every day at 08:00, "0 9 * * 1" every Monday at 09:00`
      );
    }
    return { expr: cron, tz };
  }

  const match = ISO_DATE_TIME.exec(at!);
  if (!match) throw new Error(`at: "${at}" is not an ISO 8601 date-time such as 2026-10-16T08:00`);
  let atMs: number | undefined;
  try {
    // croner 把不带偏移的 ISO 按 timezone 读、带偏移的按偏移读(10.0.1 实测);from = 0 让过去的时刻也读得出来。
    atMs = new Cron(`${match[1]}${match[2] ?? ':00'}${match[3] ?? ''}`, { timezone: tz })
      .nextRun(new Date(0))
      ?.getTime();
  } catch {
    atMs = undefined;
  }
  if (atMs == null || Number.isNaN(atMs)) {
    throw new Error(`at: "${at}" is not a real date-time — e.g. 2026-10-16T08:00`);
  }
  if (atMs <= now) {
    throw new Error(`at: ${describeScheduleTime(atMs, tz)} has already passed; it is now ${describeScheduleTime(now, tz)}`);
  }
  if (atMs - now < MIN_ONE_TIME_LEAD_MS) {
    throw new Error(
      `at: ${describeScheduleTime(atMs, tz)} is less than a minute from now (${describeScheduleTime(now, tz)}); schedules are checked once a minute, so pick a time at least one minute ahead`
    );
  }
  return { expr: '', tz, at: atMs };
}
