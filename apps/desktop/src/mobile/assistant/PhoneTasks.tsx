import { formatSessionTitleForDisplay } from '@/session/shared/core/sessions/session-title-utils'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { useAssistantWorkTasks, openAssistantPanelTask } from '@/components/assistant/assistant-panel-tasks'
import {useAuth} from '@/store/auth'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Clock } from '@/lib/icons'
import { assistantTaskDeviceLabel } from '@/session/renderer/features/assistant/assistant-task-directory'
import { groupByDay } from '@/session/renderer/features/assistant/assistant-lineage'
import { scheduleText } from '@/session/renderer/features/assistant/assistant-schedule'
import { AssistantEmpty, AssistantRow, AssistantSection } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { useDevicesStore } from '@/store/devicesContext'
import { StatusGlyph } from '../agent-watch/StatusGlyph'
import type { PhonePageProps } from './MobileAssistantApp'
import {AssistantWorkTaskRead} from '@/components/assistant/AssistantWorkTaskRead'
import { PhoneRoutineRead } from './PhoneRoutineRead'
import { PhoneRoutineDetail } from './PhoneRoutineDetail'
import { usePhoneRoutines } from './usePhoneRoutines'

/**
 * 「任务」同页展示派出去的工作与定时任务。任务 = 账号账本里它派出去的工作,
 * 按日期分组,点一条直接打开任务 Agent 的聊天,带上与个人助理的协作消息;
 * 定时 = 它家里「已安排」里它给自己排的,点一条往下钻到 `routine:<id>`(能停能删,改时间交给它)。新建交给它:往聊天里填一句。
 */
export function PhoneTasks(props: PhonePageProps) {
  const { t } = useTranslation('assistant')
  if (props.sub?.startsWith('routine:')) return <PhoneRoutineDetail key={props.sub} {...props} id={props.sub.slice('routine:'.length)} />
  return (
    <div className="ta-page" data-testid="assistant-tasks">
      <div className="ta-phone-actions">
        <Button variant="ghost" className="ta-pill-btn" onClick={() => props.askInChat(t('tasks.createPrompt'))} data-testid="assistant-tasks-create">
          {t('tasks.create')}
        </Button>
      </div>
      <SubAgents {...props} />
      <AssistantSection title={t('routines.title')} bare action={
        <Button variant="ghost" className="ta-pill-btn" onClick={() => props.askInChat(t('routines.createPrompt'))} data-testid="assistant-routines-create">
          {t('routines.create')}
        </Button>
      }><Routines {...props} /></AssistantSection>
    </div>
  )
}

function SubAgents({ assistant, askInChat }: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const { devices: hosts,phones = [] } = useDevicesStore()
  const devices = [...hosts,...phones]
  const {user}=useAuth()
  const read=useAssistantWorkTasks(user?.id,assistant.id)
  return <AssistantWorkTaskRead read={read} failedTitle={t('tasks.loadFailed')}>{children => children.length === 0
    ? <AssistantSection bare><AssistantEmpty title={t('tasks.emptyTitle')} action={<Button variant="ghost" className="ta-pill-btn"
      onClick={() => askInChat(t('tasks.createPrompt'))}>{t('tasks.create')}</Button>} /></AssistantSection>
    : groupByDay(children,item => item.lastInteractedAt,new Date()).map(group => <AssistantSection key={group.bucket}
      title={t(`tasks.day.${group.bucket}`)} testId={`assistant-tasks-${group.bucket}`}>
      {group.items.map(task => <AssistantRow key={task.key} testId={`assistant-subagent-${task.id}`} title={formatSessionTitleForDisplay(task.harness ?? '',task.title)}
        detail={assistantTaskDeviceLabel(devices,task.deviceId)}
        trailing={<StatusGlyph presentation={presentAgentStatus({ reading: task.status,unseen: task.unseen })} />}
        chevron onClick={() => openAssistantPanelTask({assistantId:assistant.id},task)} />)}
    </AssistantSection>)}</AssistantWorkTaskRead>
}

function Routines(props: PhonePageProps) {
  const { assistant, askInChat, go } = props
  const { t, i18n } = useTranslation('assistant')
  const { read, routines, directory } = usePhoneRoutines(props)
  const formatAt = (at: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  return (
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
  )
}
