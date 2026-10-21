import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';
import type { RunError } from './automation-run';
import type { TriggerConfig } from './config';

/**
 * 一条会话给自己排的一条定时(#7221 schedule_create),任务页拿来告诉人「这个任务还会回来」。
 * 读的是那台机器自己的「已安排」(automations + automation_runs),与「已安排」页同一份事实,❌ 另存一份。
 */
export type SessionSchedule = {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  trigger: TriggerConfig;
  enabled: boolean;
  /** 排着的下一次(`status='scheduled'` 那一行);没有 = 不会再响。 */
  nextRunAt: number | null;
  /** 最近一次送到、失败或错过的(人自己造成的跳过不算);一次都没有 = null。 */
  lastRun: { status: 'done' | 'failed' | 'skipped'; at: number | null; error: RunError | null } | null;
};

/**
 * 跳过里只有这两种是「这一次没送到」:机器关着过了点、上一次还没跑完。
 * 其余跳过(人停了、删了、改了规则)是人自己做的,不提醒。
 */
export const MISSED_RUN_CODES: readonly string[] = ['deadline_exceeded', 'previous_running'];
const MISSED_CODES = new Set(MISSED_RUN_CODES);

export type ScheduleAttention = 'failed' | 'missed';

/** 最近一次没送到要不要告诉人:失败,或上面那两种跳过。下一次送到了它自己就不再是最近一次。 */
export function scheduleAttention(schedule: Pick<SessionSchedule, 'lastRun'>): ScheduleAttention | null {
  const last = schedule.lastRun;
  if (!last) return null;
  if (last.status === 'failed') return 'failed';
  if (last.status === 'skipped' && last.error && MISSED_CODES.has(last.error.code)) return 'missed';
  return null;
}

/** 还会回来:开着,且排着下一次。 */
export function schedulePending(schedule: Pick<SessionSchedule, 'enabled' | 'nextRunAt'>): boolean {
  return schedule.enabled && schedule.nextRunAt != null;
}

/**
 * 任务页要给人看的那几条:还会回来的,加上最近一次没送到的。
 * 人在「已安排」里停掉的不看(他自己停的);一次性的过了点被自动关掉、最后一次没送到的要看 —— 那是它唯一的一次。
 */
export function scheduleShown(schedule: SessionSchedule, now = Date.now()): boolean {
  if (schedulePending(schedule)) return true;
  if (!scheduleAttention(schedule)) return false;
  if (schedule.enabled) return true;
  const at = schedule.trigger.at;
  return at != null && at <= now;
}

/** 下一个要回来的在前;没有下一次的(只剩没送到)排后面。 */
export function compareSessionSchedules(a: SessionSchedule, b: SessionSchedule): number {
  if (a.nextRunAt === b.nextRunAt) return 0;
  if (a.nextRunAt == null) return 1;
  if (b.nextRunAt == null) return -1;
  return a.nextRunAt - b.nextRunAt;
}

/**
 * 一条会话的那几条(已按 `compareSessionSchedules` 排好、已按 `scheduleShown` 筛过)→ 列表一行上那枚标记。
 * 桌面本机的行与摘要里那一格(手机、别的电脑)都从这里算,❌ 两边各写一份。
 */
export function sessionScheduleDigest(schedules: readonly SessionSchedule[]): SessionpageScheduleDigest | null {
  const first = schedules[0];
  if (!first) return null;
  const pending = schedules.find(schedulePending);
  let attention: SessionpageScheduleDigest['attention'] = null;
  for (const schedule of schedules) {
    const kind = scheduleAttention(schedule);
    if (kind) {
      attention = { kind, title: schedule.title };
      break;
    }
  }
  return {
    count: schedules.length,
    nextAt: pending?.nextRunAt != null ? new Date(pending.nextRunAt).toISOString() : null,
    title: (pending ?? first).title,
    attention,
  };
}

/** 整台机器的那几条按会话分组(顺序保持)。 */
export function schedulesBySession(schedules: readonly SessionSchedule[]): Map<string, SessionSchedule[]> {
  const bySession = new Map<string, SessionSchedule[]>();
  for (const schedule of schedules) {
    const list = bySession.get(schedule.sessionId);
    if (list) list.push(schedule);
    else bySession.set(schedule.sessionId, [schedule]);
  }
  return bySession;
}
