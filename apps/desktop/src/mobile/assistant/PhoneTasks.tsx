import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { AlignJustify, Clock } from '@/lib/icons'
import { assistantDescendants, groupByDay } from '@/session/renderer/features/assistant/assistant-lineage'
import { scheduleText } from '@/session/renderer/features/assistant/assistant-schedule'
import { AssistantEmpty, AssistantRow, AssistantSection, WideSegments } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { formatSessionTitleForDisplay } from '@/session/shared/core/sessions/session-title-utils'
import { openAssistantTaskChat } from '@/lib/assistantTaskChat'
import { deviceSessionsOf, directoryRows, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { useDevicesStore } from '@/store/devicesContext'
import { StatusGlyph } from '../agent-watch/StatusGlyph'
import { sessionPresentation } from '../agent-watch/watch-status'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneMachineGate } from './PhoneMachineGate'
import { ReadView } from './PhoneMachineView'
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
        <WideSegments
          items={[
            { id: 'tasks', label: t('tasks.segment'), icon: <AlignJustify /> },
            { id: 'scheduled', label: t('routines.title'), icon: <Clock /> },
          ]}
          value={segment}
          onChange={setSegment}
        />
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

function SubAgents({ assistant, cloudDeviceId, readiness, askInChat }: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const { devices } = useDevicesStore()
  const live = useLiveDeviceSessions()
  const online = useMemo(() => new Map(devices.map((device) => [device.device_id, device.is_online])), [devices])
  const listed = directoryRows(devices, live).map(({ deviceId, session }) => ({ deviceId, summary: session }))
  const children = assistantDescendants(listed, assistant.id)
  const cloud = devices.find((device) => device.device_id === cloudDeviceId) ?? null
  const cloudRead = cloud ? deviceSessionsOf(cloud, live) : null
  if (children.length === 0) {
    return (
      <AssistantSection bare>
        <AssistantEmpty
          title={t('tasks.emptyTitle')}
          action={
            <Button variant="ghost" className="ta-pill-btn" onClick={() => askInChat(t('tasks.createPrompt'))}>
              {t('tasks.create')}
            </Button>
          }
        >
          {!cloudRead || (cloudRead.sessions.length === 0 && readiness !== 'ready')
            ? t('tasks.notRead', { name: assistant.display_name })
            : t('tasks.empty', { name: assistant.display_name })}
        </AssistantEmpty>
      </AssistantSection>
    )
  }
  return (
    <>
      {groupByDay(children, (item) => item.summary.lastInteractedAt, new Date()).map((group) => (
        <AssistantSection key={group.bucket} title={t(`tasks.day.${group.bucket}`)} testId={`assistant-tasks-${group.bucket}`}>
          {group.items.map(({ deviceId, summary }) => {
            const opens = !!summary.agent?.userId
            const openable = online.get(deviceId) === true && opens
            return (
              <AssistantRow
                key={summary.conversationId}
                testId={`assistant-subagent-${summary.conversationId}`}
                title={formatSessionTitleForDisplay(summary.harness, summary.title)}
                detail={deviceId === cloudDeviceId ? null : devices.find((device) => device.device_id === deviceId)?.label}
                trailing={<StatusGlyph presentation={sessionPresentation(summary, openable)} />}
                // 点得开的那几行右边一个 ›(手机上一眼看出能点);点不开的只是一条记录。
                chevron={opens}
                onClick={opens ? () => openAssistantTaskChat(assistant.id, { deviceId, summary }, listed) : undefined}
              />
            )
          })}
        </AssistantSection>
      ))}
    </>
  )
}

/** 它排的定时任务:进行中 / 已停用两段,一行一个(右边说什么时候),点一条往下钻看详情。 */
function Routines(props: PhonePageProps) {
  const { assistant, readiness, askInChat, go } = props
  const { t, i18n } = useTranslation('assistant')
  const { read, routines } = usePhoneRoutines(props)
  const formatAt = (at: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  return (
    <PhoneMachineGate readiness={readiness} name={assistant.display_name}>
      <ReadView read={read} failedTitle={t('routines.loadFailed')}>
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
      </ReadView>
    </PhoneMachineGate>
  )
}
