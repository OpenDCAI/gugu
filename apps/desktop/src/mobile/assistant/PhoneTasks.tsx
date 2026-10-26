import { useState } from 'react'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { readAssistantPanelTasks, openAssistantPanelTask } from '@/components/assistant/assistant-panel-tasks'
import { machineKey, usePhoneRead } from './usePhoneRead'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Clock } from '@/lib/icons'
import { assistantTaskDeviceLabel } from '@/session/renderer/features/assistant/assistant-task-directory'
import { groupByDay } from '@/session/renderer/features/assistant/assistant-lineage'
import { scheduleText } from '@/session/renderer/features/assistant/assistant-schedule'
import { AssistantEmpty, AssistantRow, AssistantSection } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { useDevicesStore } from '@/store/devicesContext'
import { StatusGlyph } from '../agent-watch/StatusGlyph'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineGate } from './PhoneMachineGate'
import { ReadView } from './PhoneMachineView'
import { PhoneRoutineRead } from './PhoneRoutineRead'
import { PhoneRoutineDetail } from './PhoneRoutineDetail'
import { usePhoneRoutines } from './usePhoneRoutines'

/**
 * 「任务」那一格:[任务 | 定时] 两段。任务 = 它派出去的子 agent(各台机器的会话目录里,父会话链上是它的),
 * 按日期分组,点一条直接打开任务 Agent 的聊天,带上与个人助理的协作消息;
 * 定时 = 它家里「已安排」里它给自己排的,点一条往下钻到 `routine:<id>`(能停能删,改时间交给它)。新建交给它:往聊天里填一句。
 */
export function PhoneTasks(props: PhonePageProps) {
  const { t } = useTranslation('assistant')
  // 详情页摆着时这一格不卸:返回时还在进去之前那一段(定时)。
  const [segment, setSegment] = useState<'tasks' | 'scheduled'>('tasks')
  if (props.sub?.startsWith('routine:')) return <PhoneRoutineDetail key={props.sub} {...props} id={props.sub.slice('routine:'.length)} />
  return (
    <div className="ta-page" data-testid="assistant-tasks">
      <div className="ta-phone-actions">
        <div className="ta-phone-page-segments">
          <SegmentedTabs
            items={[
              { value: 'tasks', label: t('tasks.segment'), testId: 'assistant-seg-tasks' },
              { value: 'scheduled', label: t('routines.title'), testId: 'assistant-seg-scheduled' },
            ]}
            value={segment}
            onChange={setSegment}
            ariaLabel={t('tasks.title')}
          />
        </div>
        <Button variant="ghost" className="ta-pill-btn"
          onClick={() => props.askInChat(segment === 'tasks' ? t('tasks.createPrompt') : t('routines.createPrompt'))}
          data-testid="assistant-tasks-create"
        >
          {segment === 'tasks' ? t('tasks.create') : t('routines.create')}
        </Button>
      </div>
      {segment === 'tasks' ? <SubAgents {...props} /> : <Routines {...props} />}
    </div>
  )
}

function SubAgents({ machine, askInChat }: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const { devices: hosts,phones = [] } = useDevicesStore()
  const devices = [...hosts,...phones]
  const ready = machine.state === 'ready' ? machine.machine : null
  const read = usePhoneRead(ready ? `tasks|${machineKey(ready)}` : null,() => readAssistantPanelTasks(ready!.panel!),'read assistant tasks')
  return <ReadView read={read} failedTitle={t('tasks.loadFailed')}>{children => children.length === 0
    ? <AssistantSection bare><AssistantEmpty title={t('tasks.emptyTitle')} action={<Button variant="ghost" className="ta-pill-btn"
      onClick={() => askInChat(t('tasks.createPrompt'))}>{t('tasks.create')}</Button>} /></AssistantSection>
    : groupByDay(children,item => item.lastInteractedAt,new Date()).map(group => <AssistantSection key={group.bucket}
      title={t(`tasks.day.${group.bucket}`)} testId={`assistant-tasks-${group.bucket}`}>
      {group.items.map(task => <AssistantRow key={task.id} testId={`assistant-subagent-${task.id}`} title={task.title}
        detail={assistantTaskDeviceLabel(devices,task.deviceId)}
        trailing={<StatusGlyph presentation={presentAgentStatus({ reading: task.status,unseen: false })} />}
        chevron={!!task.agentId} onClick={task.agentId ? () => openAssistantPanelTask(ready!.panel!,task) : undefined} />)}
    </AssistantSection>)}</ReadView>
}

function Routines(props: PhonePageProps) {
  const { assistant, readiness, askInChat, go } = props
  const { t, i18n } = useTranslation('assistant')
  const { read, routines, directory } = usePhoneRoutines(props)
  const formatAt = (at: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  return (
    <PhoneMachineGate readiness={readiness} name={assistant.display_name}>
      <PhoneRoutineRead read={read} directory={directory}>
        {() =>
          routines.length === 0 ? (
            <AssistantEmpty
              title={t('routines.emptyTitle')}
              action={
                <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('routines.createPrompt'))}>
                  {t('routines.create')}
                </Button>
              }
            >
              {t('routines.empty', { name: assistant.display_name })}
            </AssistantEmpty>
          ) : (
            (['active', 'inactive'] as const).map((group) => {
              const items = routines.filter((routine) => routine.enabled === (group === 'active'))
              return items.length ? (
                <AssistantSection key={group} title={t(`routines.${group}`)} testId={`assistant-routines-${group}`}>
                  {items.map((routine) => (
                    <AssistantRow
                      key={routine.id}
                      testId={`assistant-routine-${routine.id}`}
                      leading={<Clock className="ta-file-icon" />}
                      title={routine.name}
                      trailing={scheduleText(routine, i18n.language, formatAt, t)}
                      onClick={() => go(`routine:${routine.id}`)}
                    />
                  ))}
                </AssistantSection>
              ) : null
            })
          )
        }
      </PhoneRoutineRead>
    </PhoneMachineGate>
  )
}
