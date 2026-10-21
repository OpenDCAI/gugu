import { useState } from 'react';
import {
  cronTrigger,
  fromLocalInputValue,
  oneTimeTrigger,
  timeOfDayOf,
  toLocalInputValue,
  tomorrowNine,
  withTimeOfDay,
} from '@renderer/features/automations/session-schedule-edit';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TriggerConfig } from '@shared/core/automations/config';
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

const fieldClass =
  'h-7 rounded-md border border-border bg-transparent px-2 text-sm text-foreground tabular-nums outline-none focus-visible:border-foreground-muted';
const chipClass = 'h-6 rounded-md border border-border px-2 text-xs text-foreground-muted hover:bg-row-hover hover:text-foreground';

/**
 * 托盘弹层里那一条「改时间」展开的样子(owner 10-19 A:只改时间,交代仍归 agent)。
 * 一次性:日期 + 时刻,加三个常用的(+30 分钟、+1 小时、明早 9 点);重复的「分 时 * * 星期」只改几点;别的 cron 改整条规则。
 * 能不能这样改由主进程判(一分钟以内、算不出下一次的都拒),这里只把人填的交上去。
 */
export function SessionScheduleTimeEditor({
  schedule,
  busy,
  onSave,
  onDiscard,
}: {
  schedule: SessionSchedule;
  busy: boolean;
  onSave: (trigger: TriggerConfig) => void;
  onDiscard: () => void;
}) {
  const { translate } = useSessionMessages();
  const trigger = schedule.trigger;
  const base = schedule.nextRunAt ?? Date.now();
  const [at, setAt] = useState(toLocalInputValue(base));
  const timeOfDay = trigger.at == null ? timeOfDayOf(trigger.expr) : null;
  const [time, setTime] = useState(timeOfDay ?? '09:00');
  const [expr, setExpr] = useState(trigger.expr);
  const zone = trigger.tz && trigger.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? trigger.tz : null;

  function next(): TriggerConfig | null {
    if (trigger.at != null) {
      const ms = fromLocalInputValue(at);
      return ms == null ? null : oneTimeTrigger(trigger, ms);
    }
    if (timeOfDay) {
      const nextExpr = withTimeOfDay(trigger.expr, time);
      return nextExpr ? cronTrigger(trigger, nextExpr) : null;
    }
    return expr.trim() ? cronTrigger(trigger, expr) : null;
  }
  const proposed = next();

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="session-schedule-time-editor">
      {trigger.at != null ? (
        <>
          <input
            type="datetime-local"
            className={fieldClass}
            value={at}
            aria-label={translate('sessionSchedule.edit')}
            onChange={(event) => setAt(event.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            <button type="button" className={chipClass} onClick={() => setAt(toLocalInputValue(base + 30 * 60_000))}>
              {translate('sessionSchedule.plus30')}
            </button>
            <button type="button" className={chipClass} onClick={() => setAt(toLocalInputValue(base + 60 * 60_000))}>
              {translate('sessionSchedule.plus60')}
            </button>
            <button type="button" className={chipClass} onClick={() => setAt(toLocalInputValue(tomorrowNine()))}>
              {translate('sessionSchedule.tomorrowNine')}
            </button>
          </div>
        </>
      ) : timeOfDay ? (
        <div className="flex items-center gap-2">
          <input
            type="time"
            className={fieldClass}
            value={time}
            aria-label={translate('sessionSchedule.edit')}
            onChange={(event) => setTime(event.target.value)}
          />
          {/* 重复的那条按它自己的时区算几点;那台机器(或建它时说的时区)和这边不同时,说清是哪里的几点。 */}
          {zone ? <span className="text-xs text-foreground-muted">{translate('sessionSchedule.inZone', { zone })}</span> : null}
        </div>
      ) : (
        <input
          type="text"
          className={fieldClass}
          value={expr}
          aria-label={translate('sessionSchedule.cronRule')}
          spellCheck={false}
          onChange={(event) => setExpr(event.target.value)}
        />
      )}
      <div className="flex gap-1">
        <button
          type="button"
          disabled={busy || proposed == null}
          className="h-6 rounded-md bg-primary-button-background px-2 text-xs text-primary-button-foreground hover:opacity-[.88] disabled:opacity-50"
          data-testid="session-schedule-time-save"
          onClick={() => proposed && onSave(proposed)}
        >
          {translate('sessionSchedule.save')}
        </button>
        <button type="button" className="h-6 rounded-md px-2 text-xs text-foreground-muted hover:bg-row-hover" onClick={onDiscard}>
          {translate('sessionSchedule.discard')}
        </button>
      </div>
    </div>
  );
}
