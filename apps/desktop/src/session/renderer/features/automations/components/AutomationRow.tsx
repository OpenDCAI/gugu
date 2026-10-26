import { AutomationAgentAvatar } from './AutomationAgentAvatar';
import cronstrue from 'cronstrue';
import { CheckCircle2, Clock, Folder, MinusCircle, XCircle, type IconComponent } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import {
  useLatestAutomationRun,
  useScheduledAutomationRun,
} from '@renderer/features/automations/use-automations';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import {
  getSessionPageStore,
  sessionAgentStatus,
  sessionAgentStatusDetail,
} from '@renderer/features/sessions/stores/session-selectors';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { AbsoluteTime } from '@renderer/lib/ui/absolute-time';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { isSpentOneTimeAutomation, type Automation } from '@shared/core/automations/automation';
import type { AutomationRunStatus } from '@shared/core/automations/automation-run';
import { formatRunTriggerKindLabel } from '../automation-run-format';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

const RUN_STATUS_ICON: Record<
  AutomationRunStatus,
  { Icon: IconComponent; textClass: string; spin?: boolean }
> = {
  scheduled: { Icon: Clock, textClass: 'text-foreground-muted' },
  queued: { Icon: Clock, textClass: 'text-foreground-muted' },
  creating_session: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  launching_session: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  starting_agent: { Icon: Clock, textClass: 'text-foreground-muted', spin: true },
  done: { Icon: CheckCircle2, textClass: 'text-foreground-success' },
  failed: { Icon: XCircle, textClass: 'text-foreground-error' },
  skipped: { Icon: MinusCircle, textClass: 'text-foreground-muted' },
};

interface AutomationRowProps {
  automation: Automation;
  onToggleEnabled?: (enabled: boolean) => void;
  onClick?: () => void;
}

export const AutomationRow = observer(function AutomationRow({
  automation,
  onToggleEnabled,
  onClick,
}: AutomationRowProps) {
  const { translate } = useSessionMessages();
  const latestRunQuery = useLatestAutomationRun(automation.id);
  const scheduledRunQuery = useScheduledAutomationRun(automation.id);

  const run = latestRunQuery.data ?? null;
  const scheduledAt = scheduledRunQuery.data?.scheduledAt ?? null;

  // #7221 agent 给自己排的:每次都送回建它的那条会话,状态就看那条会话的。
  const sessionId = run?.sessionId ?? automation.agentSessionId ?? null;
  const projectId = automation.projectId ?? null;
  // 别的机器上的项目与本机的是同一张项目表、同一张任务表(#6264 一套工作台)。
  const sessionPageStore = sessionId && projectId ? getSessionPageStore(projectId, sessionId) : undefined;
  const agentStatus = sessionPageStore ? sessionAgentStatus(sessionPageStore) : null;
  const agentStatusDetail = sessionPageStore ? sessionAgentStatusDetail(sessionPageStore) : null;
  const projectName = projectId ? projectDisplayName(getProjectStore(projectId)) : undefined;

  const expr = automation.triggerConfig?.expr ?? null;
  const cronLabel = automation.triggerConfig?.at != null
    ? translate('automations.oneTime')
    : expr
    ? (() => {
        try {
          return cronstrue.toString(expr.trim());
        } catch {
          return expr;
        }
      })()
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className="group flex cursor-pointer items-center gap-4 rounded-lg px-4 py-3 text-left transition-colors hover:bg-row-hover"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="flex flex-row items-center justify-end gap-3"
      >
        <Switch
          checked={automation.enabled}
          // #7221 一次性的那一刻过了就不会再响,打开它没有意义(服务端也拒)。
          disabled={isSpentOneTimeAutomation(automation)}
          onCheckedChange={(checked) => onToggleEnabled?.(checked)}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* Row 1: name + agent indicator left, cron + project right */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                'min-w-0 truncate text-md',
                automation.enabled ? 'text-foreground' : 'text-foreground-muted'
              )}
            >
              {automation.name}
            </span>
            <AgentStatusIndicator status={agentStatus} detail={agentStatusDetail} />
          </div>
          <div className="flex shrink-0 flex-row items-center gap-1 text-xs text-foreground-muted">
            {automation.agentSession && (
              <span
                className={cn(
                  'flex max-w-40 items-center gap-1 rounded-md bg-background-1 px-2 py-1 group-hover:state-hover-layer',
                  automation.agentSession.gone ? 'text-foreground-destructive/80' : 'text-foreground-muted'
                )}
              >
                <AutomationAgentAvatar sessionId={automation.agentSessionId} />
                <span className="min-w-0 truncate">
                  {automation.agentSession.gone
                    ? translate('automations.byAgentGone')
                    : translate('automations.byAgent', { name: automation.agentSession.name ?? '' })}
                </span>
              </span>
            )}
            {cronLabel && (
              <span className="flex items-center gap-1 rounded-md bg-background-1 px-2 py-1 text-foreground-muted group-hover:state-hover-layer">
                <Clock className="size-3 shrink-0" />
                <span className="shrink-0">{cronLabel}</span>
              </span>
            )}
            <div className="flex max-w-32 flex-row items-center gap-1.5 rounded-md bg-background-1 px-2 py-1 text-foreground-muted group-hover:state-hover-layer">
              <Folder className="size-3 shrink-0" />
              <span
                className={cn(
                  'min-w-0 truncate text-xs font-normal',
                  projectId == null && 'text-foreground-destructive/80'
                )}
              >
                {projectId ? projectName : translate('automations.noProject')}
              </span>
            </div>
          </div>
        </div>

        {/* Row 2: latest run sentence left, next run / disabled right */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          {run ? (
            (() => {
              const { Icon, textClass, spin } = RUN_STATUS_ICON[run.status];
              const time = run.startedAt ?? run.finishedAt;
              return (
                <span className="flex items-center gap-1.5 text-sm text-foreground-muted">
                  {spin ? (
                    <LoadingIndicator size="inline" className={textClass} />
                  ) : (
                    <Icon className={cn('size-3.5 shrink-0', textClass)} />
                  )}
                  {translate('automations.lastRunOn')}
                  {time && <AbsoluteTime value={time} className="text-foreground-muted" />}·{' '}
                  {formatRunTriggerKindLabel(translate, run.triggerKind)}
                </span>
              );
            })()
          ) : (
            <span className="text-sm text-foreground-passive">
              {translate('automations.noRuns')}
            </span>
          )}

          <div className="shrink-0 text-xs text-foreground-muted">
            {automation.enabled ? (
              scheduledAt ? (
                <span className="flex items-center gap-1">
                  {translate('automations.nextRunScheduled')}
                  <AbsoluteTime value={scheduledAt} />
                </span>
              ) : null
            ) : (
              <span className="text-foreground-passive">
                {/* #7221 跑过的一次性不是被谁关掉了,是那一次已经过去了(成败看左边那一行的图标)。 */}
                {translate(isSpentOneTimeAutomation(automation) ? 'automations.oneTimeEnded' : 'automations.disabled')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
