import { observer } from 'mobx-react-lite';
import { SessionGitDiffStats } from '@renderer/features/sessions/components/session-git-diff-stats';
import { type SessionPageStore } from '@renderer/features/sessions/stores/session-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';

export interface SessionDataLineProps {
  session: SessionPageStore;
  // @@@sessionpage otty-state — widened from AgentStatus to the 6-value badge projection so it accepts a
  // `needs_user` from sessionAgentStatus (fed by AutomationRunRow).
  agentStatus: AgentStatus | null;
  /** 附属态(后台在跑静止、需要你写出在等什么)。 */
  agentStatusDetail?: AgentStatusDetail | null;
  missedDeadline: boolean;
}

export const SessionDataLine = observer(function SessionDataLine({
  session,
  agentStatus,
  agentStatusDetail = null,
  missedDeadline,
}: SessionDataLineProps) {
  return (
    <div className="flex h-6 min-w-0 items-center justify-between gap-2 pr-1">
      <div className="flex items-center gap-1">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm text-foreground',
            missedDeadline && 'text-foreground-destructive'
          )}
        >
          {session.displayName}
        </span>
        <AgentStatusIndicator status={agentStatus} detail={agentStatusDetail} />
      </div>
      <SessionGitDiffStats session={session} />
    </div>
  );
});
