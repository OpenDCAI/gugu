import { observer } from 'mobx-react-lite';
import { useAutomationRunActions } from '@renderer/features/automations/use-automation-run-actions';
import {
  getRegisteredSessionData,
  getSessionPageStore,
  sessionAgentStatus,
  sessionAgentStatusDetail,
} from '@renderer/features/sessions/stores/session-selectors';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { useAutomationRun } from '../use-automations';
import { RunMetaLine } from './RunMetaLine';
import { SessionDataLine } from './SessionDataLine';
import { SessionPlaceholder } from './SessionPlaceholder';

interface AutomationRunRowProps {
  runId: string;
  automationId: string;
  run?: AutomationRun;
  /** #7221 agent 给自己排的:每次运行都送回这条会话,行指向它(而不是一条新建的会话)。 */
  deliveredTo?: string;
  /** 那条会话不在了时行上写的名字:那个 agent 的名字,❌ 运行自己生成的随机占位名(它从来不是一条会话)。 */
  deliveredToName?: string | null;
}

export const AutomationRunRow = observer(function AutomationRunRow({
  runId,
  automationId,
  run: runProp,
  deliveredTo,
  deliveredToName,
}: AutomationRunRowProps) {
  const { navigate } = useNavigate();
  const { translate } = useSessionMessages();
  const fetchedRun = useAutomationRun(automationId, runId);
  const run = runProp ?? fetchedRun;
  const { projectId } = useAutomationRunActions(automationId);

  const sessionId = run ? (run.sessionId ?? deliveredTo ?? null) : null;
  const sessionPageStore = sessionId && projectId ? getSessionPageStore(projectId, sessionId) : undefined;
  const session = sessionId && projectId ? getRegisteredSessionData(projectId, sessionId) : undefined;

  // 别的机器上的运行与本机同一条路:它的任务在同一张任务表里(#6264 一套工作台)。
  const interactive = Boolean(sessionId && session && !session.archivedAt);
  const agentStatus = sessionPageStore ? sessionAgentStatus(sessionPageStore) : null;
  const agentStatusDetail = sessionPageStore ? sessionAgentStatusDetail(sessionPageStore) : null;

  const displayTime = run ? (run.startedAt ?? run.finishedAt) : null;
  const missedDeadline = run?.error?.code === 'deadline_exceeded';

  const displayName = deliveredTo !== undefined ? (deliveredToName ?? null) : (run?.generatedSessionName ?? null);

  function handleOpenSession() {
    if (!interactive) return;
    if (!sessionId || !projectId) return;
    navigate('session', { projectId, sessionId: sessionId });
  }

  if (!run) return null;

  return (
    <div
      className={cn(
        'group relative flex cursor-pointer flex-col px-2 py-2 transition-colors',
        interactive ? 'hover:bg-row-hover' : 'cursor-default opacity-70'
      )}
      role="button"
      tabIndex={interactive ? 0 : -1}
      onClick={interactive ? handleOpenSession : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              handleOpenSession();
            }
          : undefined
      }
      aria-label={
        sessionPageStore
          ? translate('automations.openTask', { name: sessionPageStore.displayName })
          : displayName
            ? translate('automations.openTask', { name: displayName })
            : translate('automations.openRun')
      }
      aria-disabled={!interactive}
    >
      {sessionPageStore ? (
        <SessionDataLine
          session={sessionPageStore}
          agentStatus={agentStatus}
          agentStatusDetail={agentStatusDetail}
          missedDeadline={missedDeadline}
        />
      ) : (
        <SessionPlaceholder name={displayName} />
      )}
      <RunMetaLine
        displayTime={displayTime}
        triggerKind={run.triggerKind}
        runStatus={run.status}
        error={run.error}
        delivery={deliveredTo !== undefined}
      />
    </div>
  );
});
