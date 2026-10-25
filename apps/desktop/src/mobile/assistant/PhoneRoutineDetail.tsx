import { messageForUser } from '@/lib/userFacingError';
import './phone-memory.css'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/toastContext'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { Trash2 } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { scheduleText } from '@/session/renderer/features/assistant/assistant-schedule'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { isSpentOneTimeAutomation } from '@/session/shared/core/automations/automation'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { PhoneMachineGate } from './PhoneMachineGate'
import { PhoneRoutineRead } from './PhoneRoutineRead'
import { usePhoneRoutines } from './usePhoneRoutines'
import { errorText, usePhoneRead } from './usePhoneRead'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

const log = rendererLogger('mobile/assistant')

function useFormatAt() {
  const { i18n } = useTranslation('assistant')
  return (at: number) => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
}

/**
 * 定时任务详情(`routine:<id>`,同桌面 RoutineDetail):开关(下次几点;一次性且已过的说已结束、不给再开)、
 * 执行时间(「改时间」只把一句话填进聊天,交给它改)、指令(只能看)、删除(先确认)。醒着才读得到(❌ 自己叫醒)。
 */
export function PhoneRoutineDetail(props: PhonePageProps & { id: string }) {
  const { t, i18n } = useTranslation('assistant')
  const { toast } = useToast()
  const formatAt = useFormatAt()
  const { assistant, homeDeviceId, readiness, askInChat, go, id } = props
  const { read, routines, directory } = usePhoneRoutines(props)
  const automation = routines.find((routine) => routine.id === id) ?? null
  /** 拨了开关、那台还没答:先按拨的样子画,答了再按读到的。 */
  const [pending, setPending] = useState<boolean | null>(null)
  const toggling = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const enabled = pending ?? automation?.enabled ?? false
  const next = usePhoneRead(
    readiness === 'ready' && homeDeviceId && automation?.enabled ? `routine-next|${homeDeviceId}|${id}|${automation.updatedAt}` : null,
    () => machineRpc(homeDeviceId!).automations.getNextScheduledRun(id),
    'next routine run',
  )
  const nextAt = next.state === 'ok' ? next.data?.scheduledAt ?? null : null
  const toggle = async (on: boolean) => {
    if (!automation || !homeDeviceId || toggling.current) return
    toggling.current = true
    setPending(on)
    let updated = false
    try {
      await machineRpc(homeDeviceId).automations.setAutomationEnabled(automation.id, on)
      updated = true
      await reportAssistantAppChange({ rpc: machineRpc(homeDeviceId) }, assistant.id, { resource: 'schedules', operation: 'edited',
        id: automation.id, deviceId: homeDeviceId, before: { name: automation.name, active: automation.enabled }, after: { name: automation.name, active: on } })
      await read.refresh()
      toast(on ? t('routines.enabledToast') : t('routines.disabledToast'), 'success')
    } catch (error) {
      log.error({ error: errorText(error) }, 'set routine enabled failed')
      toast(messageForUser(error), 'error')
    } finally {
      toggling.current = false
      setPending(null)
    }
  }
  return (
    <div className="ta-page" data-testid="assistant-routine-detail">
      <PageHead title={automation?.name ?? t('routines.title')} sub={automation ? t('routines.by', { name: assistant.display_name }) : undefined} />
      <PhoneMachineGate readiness={readiness} name={assistant.display_name}>
        <PhoneRoutineRead read={read} directory={directory}>
          {() =>
            !automation ? (
              <AssistantEmpty title={t('routines.goneTitle')}>{t('routines.gone')}</AssistantEmpty>
            ) : (
              <>
                <AssistantSection>
                  <AssistantRow
                    title={t('routines.enabled')}
                    detail={isSpentOneTimeAutomation(automation) ? t('routines.ended') : enabled ? (
                      next.state === 'error' ? <span role="alert">{t('routines.nextUnavailable')}</span>
                        : next.state === 'loading' ? t('library.loading') : nextAt ? t('routines.next', { time: formatAt(nextAt) }) : null
                    ) : null}
                    trailing={
                      <Switch
                        checked={enabled}
                        disabled={isSpentOneTimeAutomation(automation) || pending !== null}
                        aria-label={automation.name}
                        onCheckedChange={(on) => void toggle(on)}
                        data-testid="assistant-routine-switch"
                      />
                    }
                  />
                  {enabled && next.state === 'error' ? <Button variant="ghost" className="ta-pill-btn" onClick={next.reload}>{t('machine.retry')}</Button> : null}
                  <AssistantRow
                    title={t('routines.schedule')}
                    detail={scheduleText(automation, i18n.language, formatAt, t)}
                    trailing={<span className="ta-phone-row-link">{t('routines.changeTime')}</span>}
                    chevron={false}
                    onClick={() => askInChat(t('routines.editPrompt', { name: automation.name }))}
                    testId="assistant-routine-schedule"
                  />
                </AssistantSection>
                {automation.agentConfig?.prompt ? (
                  <AssistantSection title={t('routines.instructions')}>
                    <p className="ta-prose ta-card-text" data-testid="assistant-routine-prompt">
                      {automation.agentConfig.prompt}
                    </p>
                  </AssistantSection>
                ) : null}
                <div className="ta-phone-row-actions">
                  <Button variant="ghost" className="ta-pill-btn" data-tone="danger" disabled={pending !== null} onClick={() => setConfirming(true)} data-testid="assistant-routine-delete">
                    <Trash2 />
                    {t('routines.delete')}
                  </Button>
                </div>
                <PhoneConfirmDialog
                    open={confirming}
                    title={t('routines.deleteTitle')}
                    body={t('routines.deleteBody', { name: automation.name })}
                    confirmLabel={t('routines.delete')}
                    failedText={t('routines.deleteFailed')}
                    testId="assistant-routine-delete-dialog"
                    onClose={() => setConfirming(false)}
                    onConfirmed={() => go(null)}
                    onConfirm={async () => {
                      await machineRpc(homeDeviceId!).automations.deleteAutomation(automation.id)
                      await reportAssistantAppChange({ rpc: machineRpc(homeDeviceId!) }, assistant.id, { resource: 'schedules', operation: 'removed',
                        id: automation.id, deviceId: homeDeviceId!, before: { name: automation.name, active: automation.enabled } })
                      toast(t('routines.deleted'), 'success')
                    }}
                  />

              </>
            )
          }
        </PhoneRoutineRead>
      </PhoneMachineGate>
    </div>
  )
}
