import { messageForUser } from '@/lib/userFacingError';
import { AlertTriangle, Clock, Pencil, X } from '@/lib/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  formatScheduleWhen,
  scheduleMissText,
  scheduleRuleText,
} from '@renderer/features/automations/session-schedule-format';
import { sessionSchedulesQueryKey } from '@renderer/features/automations/use-session-schedules';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpcOn } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import {
  scheduleAttention,
  schedulePending,
  type SessionSchedule,
} from '@shared/core/automations/session-schedule';
import { sessionComposerTrayTriggerClassName } from './session-composer-styles';
import { SessionScheduleTimeEditor } from './session-schedule-time-editor';
import type { TriggerConfig } from '@shared/core/automations/config';

/**
 * 这个任务给自己排的定时(#7221 schedule_create):一颗芯片,写下一个几点回来 · 回来做什么,一行,长了截断、
 * 悬停看全文;不止一条时只写最近的那条再跟 +N。点开是浮在上面的弹层,列出全部、可改时间 / 取消 / 重试。
 * 人点进来最想知道的是「它还挂着没有」,所以放在一直在原地的那一行,❌ 放进会被后面回合推走的输出流,
 * 也 ❌ 自己再占一行(终端会被往上推,owner 10-19)。两种形态同一颗芯片,各一个位置:
 * 聊天形态在输入框上沿的托盘里(acp-chat-panel),终端形态在「添加上下文」左边(ContextBar 的 leading)。
 * 调用方只在有定时时放它(那条托盘 / 那一行跟着它出现)。
 */
export function SessionScheduleChip({
  machine,
  schedules,
}: {
  /** 这条会话所在的机器(null = 本机);`schedules` = 那台机器上它的 useSessionSchedules。 */
  machine: string | null;
  schedules: readonly SessionSchedule[];
}) {
  const { locale, translate } = useSessionMessages();
  const [open, setOpen] = useState(false);

  const head = schedules[0];
  if (!head) return null;

  const anyAttention = schedules.some((schedule) => scheduleAttention(schedule) !== null);
  const headWhen = schedulePending(head) && head.nextRunAt != null ? formatScheduleWhen(head.nextRunAt, locale, translate) : null;
  const headAttention = scheduleAttention(head);
  const headText =
    headWhen || !headAttention
      ? head.title
      : translate(headAttention === 'failed' ? 'sessionSchedule.badgeFailed' : 'sessionSchedule.badgeMissed', {
          title: head.title,
        });
  const more = schedules.length - 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(sessionComposerTrayTriggerClassName, 'max-w-full overflow-hidden text-xs text-[var(--em-foreground-muted)]')}
        title={headWhen ? `${headWhen} · ${headText}` : headText}
        data-testid="session-schedule-chip"
        data-attention={anyAttention || undefined}
      >
        {anyAttention ? (
          <AlertTriangle className="size-3 shrink-0 text-[var(--warn)]" />
        ) : (
          <Clock className="size-3 shrink-0" />
        )}
        {headWhen ? (
          <>
            <span className="shrink-0 tabular-nums">{headWhen}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span className="min-w-0 truncate text-[var(--em-foreground)]">{headText}</span>
        {more > 0 ? (
          <span className="shrink-0 tabular-nums">{translate('sessionSchedule.more', { count: more })}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-96 gap-0 p-2" data-testid="session-schedule-list">
        <div className="px-2 pt-1 pb-2 text-xs text-foreground-muted">
          {translate('sessionSchedule.listTitle', { count: schedules.length })}
        </div>
        {schedules.map((schedule) => (
          <ScheduleItem key={schedule.id} schedule={schedule} machine={machine} />
        ))}
        <ViewAllLink onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function ViewAllLink({ onNavigate }: { onNavigate: () => void }) {
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  return (
    <button
      type="button"
      className="mt-1 rounded-md border-t border-border px-2 pt-2 pb-1 text-left text-xs text-foreground-muted hover:text-foreground"
      onClick={() => {
        onNavigate();
        navigate('automations');
      }}
    >
      {translate('sessionSchedule.viewAll')} ›
    </button>
  );
}

/** 弹层里的一条:几点回来 · 标题,重复的规则,没送到的原因;动作只有真能做的那几个。 */
function ScheduleItem({ schedule, machine }: { schedule: SessionSchedule; machine: string | null }) {
  const { locale, translate } = useSessionMessages();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const pending = schedulePending(schedule);
  const attention = scheduleAttention(schedule);
  const when = pending && schedule.nextRunAt != null ? formatScheduleWhen(schedule.nextRunAt, locale, translate) : null;
  const rule = scheduleRuleText(schedule.trigger, locale);
  const last = schedule.lastRun;
  const lastWhen = last?.at != null ? formatScheduleWhen(last.at, locale, translate) : null;

  async function act(kind: 'cancel' | 'dismiss' | 'run' | 'reschedule', trigger?: TriggerConfig) {
    setBusy(true);
    try {
      const api = rpcOn(machine).automations;
      if (kind === 'reschedule' && trigger) {
        // owner 10-19 A:只改时间;主进程顺手把这件事存给 agent,它下一次干活时会看到(B)。
        await api.updateAutomationSettings(schedule.id, { triggerConfig: trigger });
        setEditing(false);
      } else if (kind === 'run') {
        await api.runAutomation(schedule.id);
      } else {
        await api.deleteAutomation(schedule.id);
        if (kind === 'cancel') toast({ title: translate('sessionSchedule.cancelled', { title: schedule.title }) });
      }
      void queryClient.invalidateQueries({ queryKey: sessionSchedulesQueryKey(machine) });
    } catch (error) {
      log.error('session schedule action failed', { kind, scheduleId: schedule.id, error: String(error) });
      const code = error instanceof Error ? error.message : '';
      toast({
        title: code.includes('schedule_too_soon')
          ? translate('sessionSchedule.tooSoon')
          : code.includes('cron_invalid') || code.includes('schedule_never_fires')
            ? translate('sessionSchedule.ruleInvalid')
            : messageForUser(error),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2 rounded-md p-2 hover:bg-row-hover"
      data-session-schedule-item={schedule.id}
      data-attention={attention ?? undefined}
    >
      {attention ? (
        <AlertTriangle className="mt-1 size-3.5 text-[var(--warn)]" />
      ) : (
        <Clock className="mt-1 size-3.5 text-foreground-muted" />
      )}
      <div className="min-w-0">
        <div className="truncate text-sm text-foreground">
          {when ? <span className="tabular-nums">{when} · </span> : null}
          {schedule.title}
        </div>
        {attention && lastWhen ? (
          <div className="text-xs text-[var(--warn)]">{scheduleMissText(attention, last?.error?.code, lastWhen, translate)}</div>
        ) : null}
        {rule ? (
          <div className="text-xs text-foreground-muted">
            {rule}
            {!attention && last?.status === 'done' && lastWhen
              ? ` · ${translate('sessionSchedule.lastDelivered', { when: lastWhen })}`
              : null}
          </div>
        ) : null}
        {schedule.prompt ? <div className="truncate text-xs text-foreground-passive">{schedule.prompt}</div> : null}
        {editing ? (
          <SessionScheduleTimeEditor
            schedule={schedule}
            busy={busy}
            onSave={(trigger) => void act('reschedule', trigger)}
            onDiscard={() => setEditing(false)}
          />
        ) : null}
        {confirming ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-foreground-muted" data-testid="session-schedule-cancel-confirm">
            <span>{translate('sessionSchedule.cancelConfirm')}</span>
            <button
              type="button"
              disabled={busy}
              className="rounded-md px-2 py-1 text-foreground-destructive hover:bg-row-hover"
              onClick={() => void act('cancel')}
            >
              {translate('sessionSchedule.cancel')}
            </button>
            <button type="button" className="rounded-md px-2 py-1 hover:bg-row-hover" onClick={() => setConfirming(false)}>
              {translate('sessionSchedule.keep')}
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        {attention ? (
          <button
            type="button"
            disabled={busy}
            className="h-6 rounded-md px-2 text-xs text-foreground-muted hover:bg-row-hover hover:text-foreground"
            onClick={() => void act('run')}
          >
            {translate(attention === 'missed' ? 'sessionSchedule.catchUp' : 'sessionSchedule.retry')}
          </button>
        ) : null}
        {pending ? (
          <button
            type="button"
            disabled={busy || editing || confirming}
            aria-label={translate('sessionSchedule.edit')}
            title={translate('sessionSchedule.edit')}
            data-testid="session-schedule-edit"
            className="flex size-6 items-center justify-center rounded-md text-foreground-muted hover:bg-row-hover hover:text-foreground"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3.5" />
          </button>
        ) : null}
        {/* 只剩没送到的一次性那条(不会再响):「不用了」就是把它删掉,不必再确认。 */}
        {attention && !pending ? (
          <button
            type="button"
            disabled={busy}
            className="h-6 rounded-md px-2 text-xs text-foreground-muted hover:bg-row-hover hover:text-foreground"
            onClick={() => void act('dismiss')}
          >
            {translate('sessionSchedule.dismiss')}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || confirming}
            aria-label={translate('sessionSchedule.cancel')}
            title={translate('sessionSchedule.cancel')}
            data-testid="session-schedule-cancel"
            className="flex size-6 items-center justify-center rounded-md text-foreground-muted hover:bg-row-hover hover:text-foreground"
            onClick={() => setConfirming(true)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
