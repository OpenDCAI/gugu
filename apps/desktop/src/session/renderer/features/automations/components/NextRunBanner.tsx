import { Clock } from '@/lib/icons'
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useScheduledAutomationRun } from '../use-automations';

interface NextRunBannerProps {
  automationId: string;
}

export function NextRunBanner({ automationId }: NextRunBannerProps) {
  const { translate } = useSessionMessages();
  const { data } = useScheduledAutomationRun(automationId);
  const scheduledAt = data?.scheduledAt ?? null;

  if (!scheduledAt) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-background-1 p-2 text-foreground-muted">
      <Clock className="size-3 shrink-0" aria-hidden />
      {translate('automations.nextRunScheduled')} <AbsoluteTime value={scheduledAt} />
    </div>
  );
}
