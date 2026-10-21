import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { CheckCircle2, Clock, MinusCircle, XCircle } from '@/lib/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { AutomationRun, AutomationRunStatus } from '@shared/core/automations/automation-run';
import { formatRunError } from '../automation-run-format';

interface RunStatusBadgeProps {
  status: AutomationRun['status'] | null;
  error: AutomationRun['error'];
  /** #7221 agent 给自己排的那一类:不建任务,把交代送回它的会话 —— 成了是「已送达」。 */
  delivery?: boolean;
}

const BASE = 'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

const PROGRESS_LABEL_KEYS: Partial<Record<AutomationRunStatus, Parameters<Translate>[0]>> = {
  creating_session: 'automations.statusCreatingTask',
  launching_session: 'automations.statusLaunchingTask',
  starting_agent: 'automations.statusStartingAgent',
};

export function RunStatusBadge({ status, error, delivery = false }: RunStatusBadgeProps) {
  const { translate } = useSessionMessages();
  if (!status || status === 'scheduled') return null;

  if (status === 'done') {
    return (
      <span className={cn(BASE, 'bg-background-success text-foreground-success')}>
        <CheckCircle2 className="size-3" />
        {translate(delivery ? 'automations.statusDelivered' : 'automations.taskCreated')}
      </span>
    );
  }

  if (status === 'failed') {
    const badge = (
      <span className={cn(BASE, 'bg-background-destructive text-foreground-destructive')}>
        <XCircle className="size-3" />
        {translate('automations.statusFailed')}
      </span>
    );
    if (!error) return badge;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className={cn(BASE, 'bg-background-destructive text-foreground-destructive cursor-default')} />
          }
        >
          <XCircle className="size-3" />
          {translate('automations.statusFailed')}
        </TooltipTrigger>
        <TooltipContent>{formatRunError(translate, error)}</TooltipContent>
      </Tooltip>
    );
  }

  if (status === 'queued') {
    return (
      <span className={cn(BASE, 'bg-background-3 text-foreground-muted')}>
        <Clock className="size-3" />
        {translate('automations.statusQueued')}
      </span>
    );
  }

  if (status === 'skipped') {
    return (
      <span className={cn(BASE, 'bg-background-3 text-foreground-muted')}>
        <MinusCircle className="size-3" />
        {translate('automations.statusSkipped')}
      </span>
    );
  }

  const progressLabelKey =
    delivery && status === 'creating_session' ? 'automations.statusDelivering' : PROGRESS_LABEL_KEYS[status];
  if (!progressLabelKey) return null;

  return (
    <span className={cn(BASE, 'bg-background-info text-foreground-info')}>
      <LoadingIndicator size="inline" />
      {translate(progressLabelKey)}
    </span>
  );
}
