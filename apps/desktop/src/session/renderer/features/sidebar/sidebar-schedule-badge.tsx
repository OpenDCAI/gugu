import { AlertTriangle, Clock } from '@/lib/icons';
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';
import { formatScheduleWhen } from '@renderer/features/automations/session-schedule-format';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

/**
 * 这个任务还会回来:它给自己排了定时(#7221 schedule_create)。行尾那一格只画一枚图标 —— 空闲时盖掉「3h」那个时间,
 * 别的状态(在跑、需要你、出错…)时让位给那个状态的标志(owner 10-19 C);最近一次没送到(失败 / 错过)是 ⚠。
 * 不写时间:那一格窄,写字挤标题(owner 10-19:「有定时标志的时候就不用具体时间了」)。几点、做什么、几条在 tooltip 里。
 *
 * 那一格一 hover 就让给置顶 / 归档(pointer-events-none 加淡出),所以 tooltip 不挂在这里,挂在 hover 层里接过来的那一枚
 * (`SidebarScheduleHoverMark`)上。这一枚只带读屏的整句。
 */
export function SidebarScheduleMark({ digest, emphasized }: { digest: SessionpageScheduleDigest; emphasized: boolean }) {
  const lines = useScheduleLines(digest);
  return (
    <span
      className={cn(
        'flex size-5 items-center justify-center',
        digest.attention ? 'text-[var(--warn)]' : emphasized ? 'text-foreground-muted' : 'text-foreground-passive'
      )}
      data-session-schedule={digest.attention ? 'attention' : 'pending'}
      aria-label={lines.join(' · ')}
    >
      {digest.attention ? <AlertTriangle className="size-3" /> : <Clock className="size-3" />}
    </span>
  );
}

/**
 * hover 层里排在置顶 / 归档左边的那一枚:指针停在它上面出 tooltip。与那两枚钮同样 24px 的目标、同样 4px 的间距,
 * 不是按钮(点它没有动作 —— 要动去任务里那条托盘),读屏已经从静止那一枚读到整句,这里 aria-hidden。
 */
export function SidebarScheduleHoverMark({ digest }: { digest: SessionpageScheduleDigest }) {
  const lines = useScheduleLines(digest);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-hidden
            data-session-schedule-hover={digest.attention ? 'attention' : 'pending'}
            className={cn(
              'flex size-6 items-center justify-center rounded-sm',
              digest.attention ? 'text-[var(--warn)]' : 'text-foreground-tertiary-passive'
            )}
          >
            {digest.attention ? <AlertTriangle className="size-3.5" /> : <Clock className="size-3.5" />}
          </span>
        }
      />
      <TooltipContent className="max-w-80 whitespace-pre-line" data-testid="session-schedule-tooltip">
        {lines.join('\n')}
      </TooltipContent>
    </Tooltip>
  );
}

/** 没送到的那条(有就先说)、下一个几点回来做什么、几条。 */
function useScheduleLines(digest: SessionpageScheduleDigest): string[] {
  const { locale, translate } = useSessionMessages();
  const nextAt = digest.nextAt ? Date.parse(digest.nextAt) : null;
  const lines: string[] = [];
  if (digest.attention) {
    lines.push(
      translate(digest.attention.kind === 'failed' ? 'sessionSchedule.badgeFailed' : 'sessionSchedule.badgeMissed', {
        title: digest.attention.title,
      })
    );
  }
  if (nextAt != null) {
    const when = formatScheduleWhen(nextAt, locale, translate);
    lines.push(
      digest.count > 1
        ? translate('sessionSchedule.badgeMany', { count: digest.count, when, title: digest.title })
        : translate('sessionSchedule.badgeOne', { when, title: digest.title })
    );
  }
  return lines;
}
