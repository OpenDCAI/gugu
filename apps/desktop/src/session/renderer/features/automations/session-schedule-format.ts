import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';
import { differenceInCalendarDays, formatDate } from '@/i18n/format';
import { formatAbsoluteTime } from '@renderer/lib/ui/absolute-time-format';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { TriggerConfig } from '@shared/core/automations/config';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

/** 不到一小时就说还有几分钟:人扫一眼要知道的是「快了没有」。 */
const SOON_MS = 60 * 60 * 1000;

/** 定时那一刻怎么说:「今天 10:30」「明天 09:30」,再远就是「10月21日 09:00」;一小时内的带上还有几分钟。 */
export function formatScheduleWhen(at: number, locale: string, translate: Translate, now = Date.now()): string {
  const date = new Date(at);
  const days = differenceInCalendarDays(date, now);
  const time = formatDate(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, locale);
  const when =
    days === 0
      ? translate('sessionSchedule.today', { time })
      : days === 1
        ? translate('sessionSchedule.tomorrow', { time })
        : formatAbsoluteTime(date, locale, { now: new Date(now) });
  const ahead = at - now;
  if (ahead > 0 && ahead < SOON_MS) {
    return translate('sessionSchedule.inMinutes', { when, minutes: Math.max(1, Math.round(ahead / 60_000)) });
  }
  return when;
}

/** 重复的那种怎么说(「工作日 09:00」之类,交给 cronstrue);一次性的 = null。读不懂的规则原样给出。 */
export function scheduleRuleText(trigger: TriggerConfig, locale: string): string | null {
  if (trigger.at != null) return null;
  const expr = trigger.expr.trim();
  if (!expr) return null;
  try {
    return cronstrue.toString(expr, { locale: locale.startsWith('zh') ? 'zh_CN' : 'en', use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

/**
 * 最近一次没送到 / 错过,连同原因说成一句给人听的话。认得的原因码各有一句,认不出的只说没送到 —— 原文在「已安排」的运行记录里。
 * ❌ 把原因码或异常原文拼进文案。
 */
export function scheduleMissText(
  attention: 'failed' | 'missed',
  code: string | undefined,
  when: string,
  translate: Translate
): string {
  if (attention === 'missed') {
    return code === 'previous_running'
      ? translate('sessionSchedule.missed.previous_running', { when })
      : code === 'deadline_exceeded'
        ? translate('sessionSchedule.missed.deadline_exceeded', { when })
        : translate('sessionSchedule.missed.other', { when });
  }
  return code === 'interrupted_by_restart'
    ? translate('sessionSchedule.failed.interrupted_by_restart', { when })
    : code === 'no_prompt'
      ? translate('sessionSchedule.failed.no_prompt', { when })
      : translate('sessionSchedule.failed.other', { when });
}
