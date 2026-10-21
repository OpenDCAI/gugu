// 定时任务那一行右边的「每天 08:00」(schedule.displayText):常见的几种 cron 说成人话,
// 其余的交给 cronstrue。哪些定时是它排的(assistantRoutines)也在这里。桌面「助理」视图与手机助理 App 共用;
// 纯函数,单测在 assistant-schedule.test.ts。
import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';
import type { Automation } from '@shared/core/automations/automation';

export type SimpleSchedule =
  | { every: 'day'; time: string }
  | { every: 'weekday'; time: string }
  | { every: 'week'; time: string; weekday: number };

/** `分 时 * * 星期` 这几种:每天 / 周一至周五 / 每周某天。别的形状(隔几分钟、每月几号……)= null。 */
export function simpleSchedule(expr: string | null | undefined): SimpleSchedule | null {
  const parts = (expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dayOfMonth !== '*' || month !== '*') return null;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dayOfWeek === '*') return { every: 'day', time };
  if (dayOfWeek === '1-5') return { every: 'weekday', time };
  if (/^[0-7]$/.test(dayOfWeek)) return { every: 'week', time, weekday: Number(dayOfWeek) % 7 };
  return null;
}

/** 星期几的名字(0 = 周日),按界面语言。 */
export function weekdayName(weekday: number, language: string): string {
  // 2026-01-04 是周日:往后数 weekday 天就是那一天。
  return new Intl.DateTimeFormat(language, { weekday: 'long' }).format(new Date(2026, 0, 4 + weekday));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 那一行右边怎么说这次定时:一次性的说那一刻,常见的 cron 说成「每天 08:00」,别的交给 cronstrue,再不行原样给 cron。 */
export function scheduleText(automation: Pick<Automation, 'triggerConfig'>, language: string, formatAt: (at: number) => string, t: Translate): string {
  const trigger = automation.triggerConfig;
  if (trigger?.at != null) return formatAt(trigger.at);
  const expr = trigger?.expr?.trim();
  if (!expr) return '';
  const simple = simpleSchedule(expr);
  if (simple?.every === 'day') return t('routines.everyDay', { time: simple.time });
  if (simple?.every === 'weekday') return t('routines.everyWeekday', { time: simple.time });
  if (simple?.every === 'week') return t('routines.everyWeek', { day: weekdayName(simple.weekday, language), time: simple.time });
  try {
    return cronstrue.toString(expr, { locale: language.startsWith('zh') ? 'zh_CN' : 'en', use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

/**
 * 它排的定时任务:它家那台机器的「已安排」里,个人助理给自己排的那些(新的在前)。
 * 它排的 = 建它的会话是这位助理的。那条会话的身份认不出(老宿主不带、列表还没到)时:住云上 = 那台上 agent 排的都算它的
 * (那台上住的就是它);住人的电脑上 = 不算(那台上还有人自己的任务 agent,❌ 把别人排的算到它头上)。
 * 人自己建的(没有 agentSessionId)不在这里。
 */
export function assistantRoutines<A extends Pick<Automation, 'agentSessionId' | 'createdAt'>>(
  automations: readonly A[],
  agentOfSession: ReadonlyMap<string, string | null>,
  assistantId: string,
  unknownIsAssistant = true
): A[] {
  return automations
    .filter((a) => {
      if (!a.agentSessionId) return false;
      const agent = agentOfSession.get(a.agentSessionId);
      return agent === undefined || agent === null ? unknownIsAssistant : agent === assistantId;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
