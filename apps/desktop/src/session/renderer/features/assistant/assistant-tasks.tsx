import {AssistantWorkTaskRead} from '@/components/assistant/AssistantWorkTaskRead';
import {useAssistantWorkOwnerId} from '@/lib/assistantWorkReadBridge';
import { messageForUser } from '@/lib/userFacingError';
import { formatSessionTitleForDisplay } from '@shared/core/sessions/session-title-utils';
import { rendererLogger } from '@/lib/log';
import { isAssistantPanelReadRetryable, retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import { useDirectoryDevices } from '@/session/shared/remote-sessions/session-directory';
import { assistantTaskDeviceLabel } from './assistant-task-directory';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { assistantQueryKey } from './assistant-data';
import { assistantPanelRoutines } from '@/components/assistant/assistant-panel-routines';
import { useAssistantWorkTasks, openAssistantPanelTask } from '@/components/assistant/assistant-panel-tasks';
import { useTranslation } from 'react-i18next';
import { AlignJustify, Clock, Plus, Trash2 } from '@/lib/icons';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Switch } from '@renderer/lib/ui/switch';
import { isSpentOneTimeAutomation, type Automation } from '@shared/core/automations/automation';
import type { AssistantContext, AssistantPageProps } from './assistant-context';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { groupByDay } from './assistant-lineage';
import { scheduleText } from './assistant-schedule';
import { AssistantEmpty, AssistantRow, AssistantSection, MachineGate, PageHead, WideSegments } from './assistant-ui';

/**
 * 任务页:[任务 | 定时任务] 两段。
 * - 任务 = 它的子 agent,按日期分组;点一条打开任务 Agent 的聊天,带上与助理的协作消息。
 * - 定时任务 = 它给自己排的已安排(#7221 schedule_create):进行中 / 已停用,点一条看详情(能停、能删;改时间交给它)。
 * 新建都不弹表单:往左边聊天里填一句,人看过再发。
 */
type Segment = 'tasks' | 'scheduled';
// 从定时任务详情返回时回到「定时任务」那一段。
let lastSegment: Segment = 'tasks';

export const AssistantTasksPage = observer(function AssistantTasksPage({ context }: AssistantPageProps) {
  if (context.route.sub?.startsWith('routine:')) {
    return (
      <RoutinesHost context={context}>
        <RoutineDetail context={context} id={context.route.sub.slice('routine:'.length)} />
      </RoutinesHost>
    );
  }
  return <TaskLists context={context} />;
});

const TaskLists = observer(function TaskLists({ context }: AssistantPageProps) {
  const { t } = useTranslation('assistant');
  const [segment, setSegmentState] = useState<Segment>(lastSegment);
  const setSegment = (next: Segment) => {
    lastSegment = next;
    setSegmentState(next);
  };
  return (
    <div className="ta-page" data-testid="assistant-tasks">
      <PageHead
        title={t('tasks.title')}
        action={
          <button
            type="button"
            className="ta-pill-btn"
            onClick={() => context.askInChat(segment === 'tasks' ? t('tasks.createPrompt') : t('routines.createPrompt'))}
            data-testid="assistant-task-create"
          >
            <Plus />
            {segment === 'tasks' ? t('tasks.create') : t('routines.create')}
          </button>
        }
      />
      <WideSegments<Segment>
        items={[
          { id: 'tasks', label: t('tasks.segment'), icon: <AlignJustify /> },
          { id: 'scheduled', label: t('routines.title'), icon: <Clock /> },
        ]}
        value={segment}
        onChange={setSegment}
      />
      {segment === 'tasks' ? (
        <SubAgents context={context} />
      ) : (
        <RoutinesHost context={context}>
          <RoutineLists context={context} />
        </RoutinesHost>
      )}
    </div>
  );
});

/** 账号级派活账本;执行设备离线或目录撤下不影响任务记录。 */
const SubAgents = observer(function SubAgents({ context }: AssistantPageProps) {
  const devices = useDirectoryDevices();
  const { t } = useTranslation('assistant');
  const ownerId=useAssistantWorkOwnerId();
  const read=useAssistantWorkTasks(ownerId,context.assistant.id);
  return <AssistantWorkTaskRead read={read} failedTitle={t('tasks.loadFailed')}>{children=>children.length === 0 ? <AssistantSection bare><AssistantEmpty title={t('tasks.emptyTitle')}
      action={<button type="button" className="ta-pill-btn" onClick={() => context.askInChat(t('tasks.createPrompt'))}>{t('tasks.create')}</button>} /></AssistantSection>
      : groupByDay(children,item => item.lastInteractedAt,new Date()).map(group => <AssistantSection key={group.bucket} title={t(`tasks.day.${group.bucket}`)} testId={`assistant-tasks-${group.bucket}`}>
        {group.items.map(task => <AssistantRow key={task.key} testId={`assistant-subagent-${task.id}`} title={formatSessionTitleForDisplay(task.harness ?? '',task.title)}
          detail={assistantTaskDeviceLabel(devices,task.deviceId)}
          trailing={task.status && task.status.status !== 'idle' ? <AgentStatusIndicator status={task.status.status} detail={task.status.detail} /> : task.unseen ? <span className="ta-unseen" aria-label={t('tasks.unseen')} /> : null}
          chevron={false} onClick={task.agentId ? () => openAssistantPanelTask({assistantId:context.assistant.id},task) : undefined} />)}
      </AssistantSection>)}
  </AssistantWorkTaskRead>;
});

/**
 * 它排的定时任务:云电脑上那台机器的「已安排」里,个人助理给自己排的那些。
 * 它排的 = 建它的会话是这位助理的。那条会话的身份这台桌面认不出(老宿主不带、列表还没到)时,
 * 云电脑上 agent 排的都算它的 —— 云电脑上住的就是它。人自己在云电脑上建的(没有 agentSessionId)不在这里。
 */
function useAssistantRoutines(context: AssistantContext) {
  const api = context.machine?.panel ? assistantPanelRoutines(context.machine.panel) : null;
  const query = useQuery({ queryKey: assistantQueryKey(context.homeDeviceId,'schedules'),enabled: !!api,queryFn: () => api!.list(),retry: retryAssistantPanelRead,
    refetchOnWindowFocus: query => isAssistantPanelReadRetryable(query.state.error) });
  const setEnabled = useMutation({ mutationFn: async ({ id,enabled }: { id: string; enabled: boolean }) => {
    await api!.setEnabled(id,enabled,query.data?.find(row => row.id === id)?.panelRevision);
  },onSuccess: () => { void query.refetch(); } });
  const destroy = useMutation({ mutationFn: async (id: string) => { await api!.remove(id,query.data?.find(row => row.id === id)?.panelRevision); },
    onSuccess: () => { void query.refetch(); } });
  return { query,routines: query.data ?? [],setEnabled,destroy };
}

function useFormatAt() {
  const { i18n } = useTranslation('assistant');
  return (at: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

const RoutineLists = observer(function RoutineLists({ context }: AssistantPageProps) {
  const { t, i18n } = useTranslation('assistant');
  const formatAt = useFormatAt();
  const { query, routines } = useAssistantRoutines(context);
  const active = routines.filter((a) => a.enabled);
  const inactive = routines.filter((a) => !a.enabled);
  const row = (automation: Automation) => (
    <AssistantRow
      key={automation.id}
      testId={`assistant-routine-${automation.id}`}
      leading={<Clock className="ta-file-icon" />}
      title={automation.name}
      trailing={scheduleText(automation, i18n.language, formatAt, t)}
      chevron={false}
      onClick={() => context.go({ tab: 'tasks', sub: `routine:${automation.id}` })}
    />
  );
  return (
    <MachineGate failedTitle={t('routines.loadFailed')} hasData={query.data !== undefined && routines.length > 0} readiness={context.readiness} loading={context.machineLoading || query.isLoading} error={context.machineError ?? query.error} onRetry={() => void query.refetch()}>
      {routines.length === 0 ? (
        <AssistantSection bare>
          <AssistantEmpty
            title={t('routines.emptyTitle')}
            action={
              <button type="button" className="ta-pill-btn" onClick={() => context.askInChat(t('routines.createPrompt'))}>
                {t('routines.create')}
              </button>
            }
          >
            {t('routines.empty', { name: context.assistant.display_name })}
          </AssistantEmpty>
        </AssistantSection>
      ) : (
        <>
          {active.length ? (
            <AssistantSection title={t('routines.active')} testId="assistant-routines-active">
              {active.map(row)}
            </AssistantSection>
          ) : null}
          {inactive.length ? (
            <AssistantSection title={t('routines.inactive')} testId="assistant-routines-inactive">
              {inactive.map(row)}
            </AssistantSection>
          ) : null}
        </>
      )}
    </MachineGate>
  );
});

/** 定时任务详情:开关、执行时间(点了交给它改)、指令(只能看)、删除(要确认)。 */
const RoutineDetail = observer(function RoutineDetail({ context, id }: { context: AssistantContext; id: string }) {
  const { t, i18n } = useTranslation('assistant');
  const { toast } = useToast();
  const showConfirm = useShowModal('confirmActionModal');
  const formatAt = useFormatAt();
  const { query, routines, setEnabled, destroy } = useAssistantRoutines(context);
  const automation = routines.find((a) => a.id === id) ?? null;
  const scheduled = automation?.nextRunAt ?? null;
  return (
    <MachineGate hasData={!!automation} readiness={context.readiness} loading={context.machineLoading || query.isLoading} error={context.machineError ?? query.error} onRetry={() => void query.refetch()}>
      {!automation ? (
        <AssistantEmpty title={t('routines.goneTitle')}>{t('routines.gone')}</AssistantEmpty>
      ) : (
        <div className="ta-page" data-testid="assistant-routine-detail">
          <PageHead title={automation.name} sub={t('routines.by', { name: context.assistant.display_name })} />
          <AssistantSection>
            <AssistantRow
              title={t('routines.enabled')}
              detail={
                isSpentOneTimeAutomation(automation)
                  ? t('routines.ended')
                  : automation.enabled && scheduled
                    ? t('routines.next', { time: formatAt(new Date(scheduled).getTime()) })
                    : null
              }
              trailing={
                <Switch
                  checked={automation.enabled}
                  disabled={isSpentOneTimeAutomation(automation)}
                  aria-label={automation.name}
                  onCheckedChange={(enabled) =>
                    setEnabled.mutate(
                      { id: automation.id, enabled },
                      {
                        onSuccess: () => {
                          void reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'schedules', operation: 'edited',
                            id: automation.id, deviceId: context.homeDeviceId, before: { name: automation.name, active: automation.enabled }, after: { name: automation.name, active: enabled } });
                          toast({ title: enabled ? t('routines.enabledToast') : t('routines.disabledToast') });
                        },
                        onError: (error) => { rendererLogger('actions/assistant-tasks').error({ error: error }, 'action failed'); toast({ title: t('routines.updateFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' }); },
                      }
                    )
                  }
                />
              }
            />
            <AssistantRow
              title={t('routines.schedule')}
              detail={scheduleText(automation, i18n.language, formatAt, t)}
              onClick={() => context.askInChat(t('routines.editPrompt', { name: automation.name }))}
              testId="assistant-routine-schedule"
            />
          </AssistantSection>
          {automation.agentConfig?.prompt ? (
            <AssistantSection title={t('routines.instructions')}>
              <p className="ta-prose ta-card-text">{automation.agentConfig.prompt}</p>
            </AssistantSection>
          ) : null}
          <div>
            <button
              type="button"
              className="ta-pill-btn"
              data-tone="danger"
              onClick={() =>
                showConfirm({
                  title: t('routines.deleteTitle'),
                  description: t('routines.deleteBody', { name: automation.name }),
                  confirmLabel: t('routines.delete'),
                  variant: 'destructive',
                  onSuccess: () =>
                    destroy.mutate(automation.id, {
                      onSuccess: () => {
                        void reportAssistantAppChange(context.machine, context.assistant.id, { resource: 'schedules', operation: 'removed',
                          id: automation.id, deviceId: context.homeDeviceId, before: { name: automation.name, active: automation.enabled } });
                        toast({ title: t('routines.deleted') });
                        context.go({ tab: 'tasks' });
                      },
                      onError: (error) => { rendererLogger('actions/assistant-tasks').error({ error: error }, 'action failed'); toast({ title: t('routines.deleteFailed'), description: messageForUser(assistantPanelFailure(error,t)), tier: 'error' }); },
                    }),
                })
              }
            >
              <Trash2 />
              {t('routines.delete')}
            </button>
          </div>
        </div>
      )}
    </MachineGate>
  );
});

function RoutinesHost({ children }: { context: AssistantContext; children: React.ReactNode }) {
  return <>{children}</>;
}
