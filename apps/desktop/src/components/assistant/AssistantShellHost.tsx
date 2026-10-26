import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { AssistantChatSlot, type AssistantChatHandlers } from './AssistantChatSlot'
import { useAssistantDm } from './useAssistantDm'
import { MeetingReminder } from './MeetingReminder'
import { QuickChatHost } from './QuickChatHost'
import { AgentSettingsModal } from '../agentsettings/AgentSettingsModal'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { CloudComputerDot, CloudComputerRowStatus } from '../settings/CloudComputerSection'
import {
  installAssistantShellBridge,
  publishAssistantShell,
  readAssistantShellBridge,
  type AssistantSetupStep,
  type AssistantShellSlot,
} from '../../lib/assistantShellBridge'
import { refreshCloudComputer } from '../../lib/cloudComputerStore'
import { assistantIdentityState, reloadMyAssistant, useMyAssistantContact } from '../../lib/myAssistant'
import { assistantHomePlace, canSetUpCloudAssistant } from '../../lib/assistantHome'
import { readSetupStep, subscribeSetupStep, writeSetupStep } from '../../lib/assistantSetupState'
import { pendingLocalAssistant, resumeLocalAssistant, setupStillStarting } from '../../lib/assistantSetup'
import { keepFinishingLocalAssistant } from '../../lib/assistantSetupFinish'
import { requestAssistantClose } from '../../lib/assistantClose'
import { getMembership } from '../../lib/billing/membership'
import { rendererLogger } from '../../lib/log'
import { installShellSlots, readShellSlots } from '../../lib/shellSlots'
import { platform } from '../../platform'
import { AssistantOnboarding } from './AssistantOnboarding'
import { QuickChatSettingsGroup } from './ComputerHomeSettings'
import { AssistantMoveGroup, type AssistantMoveGroupProps } from './AssistantMoveGroup'
import { AssistantMoveDialog } from './AssistantMoveDialog'
import { AssistantDevicesPage } from '../devices/AssistantDevicesPage'
import { ConnectorsSection } from '../settings/ConnectorsSection'
import { AssistantSettingsPage } from './AssistantSettingsPage'
import { UI_EVENTS } from '../../lib/uiEvents'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import '../../i18n/registerAssistantCatalog'

const log = rendererLogger('assistant/shell')

installAssistantShellBridge()
installShellSlots()

function openSettings(section: ActiveSection) {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section } }))
}

/**
 * 还没有咕咕:给它安家的流程(欢迎 → 起名选色 → 称呼 → 安家),会员一键住云上、非会员装在这台电脑上。
 * 会话页的「咕咕」App 和全局设置「咕咕」那一页(没有它时)画的是同一份,数据都从壳的 store 读。
 */
export function OnboardingSlot({ snapshot: given, device: givenDevice }: { snapshot?: CloudComputerSnapshot | null; device?: Device | null } = {}) {
  const { user } = useAuth()
  const { cloudComputer, devices } = useDevicesStore()
  const snapshot = given !== undefined ? given : cloudComputer?.snapshot ?? null
  const cloudDeviceId = snapshot?.deviceId ?? null
  const device = givenDevice !== undefined ? givenDevice : cloudDeviceId ? devices.find((d) => d.device_id === cloudDeviceId) ?? null : null
  const localDeviceId = platform.capabilities.agentRuntime ? devices.find((d) => d.is_current_device)?.device_id ?? null : null
  if (!user?.id) return null
  return (
    <AssistantOnboarding
      ownerUserId={user.id}
      ownerName={user.nickname ?? null}
      snapshot={snapshot}
      device={device}
      cloudAvailable={cloudComputer !== undefined && canSetUpCloudAssistant(cloudComputer)}
      localDeviceId={localDeviceId}
    />
  )
}

/**
 * 全局设置「咕咕」那一页里的状态 / 快速聊天 / 关闭三组(owner 10-16:只有一个设置,咕咕是其中一组)。
 * 连接状态(只取真实读数)、它花了多少积分、关闭;背后是它住的那台云端宿主,但说的一律是它
 * (owner 10-15:用户看不到它住在哪;❌「云电脑」「运行中 / 休眠中」)。owner 10-17:Agent 没有休息这回事 ——
 * ❌「休息中」「这次醒着」「现在叫醒」「休息」那几行;宿主闲时收回、有事自己醒,那是后台资源的事。
 * 原来画在助理 App 的齿轮页,现在设置里直接画,App 的齿轮只是打开设置。
 */
export function AssistantStatusGroups({
  snapshot,
  device,
  assistantName,
  move = null,
}: {
  snapshot: CloudComputerSnapshot
  device: Device | null
  assistantName: string
  /** 搬家那一组(桌面传;手机没有「这台电脑」可搬回,不传)。 */
  move?: AssistantMoveGroupProps | null
}) {
  const { t } = useTranslation('assistant')
  return (
    <>
      <SettingsGroup title={t('settings.machine')}>
        <SettingsRow
          title={t('settings.cloudName', { name: assistantName })}
          leading={device ? <CloudComputerDot device={device} /> : undefined}
          description={device ? <CloudComputerRowStatus device={device} snapshot={snapshot} onUpgrade={() => openSettings('usage')} /> : null}
          data-testid="assistant-settings-status"
        />
        <SettingsRow title={t('settings.billing', { name: assistantName })} description={t('settings.billingNote')} control={<Button size="sm" onClick={() => openSettings('usage')}>{t('settings.usage')}</Button>} />
      </SettingsGroup>
      {move ? <AssistantMoveGroup {...move} /> : null}
      <QuickChatSettingsGroup assistantName={assistantName} />
      {device && (
        <SettingsGroup title={t('settings.danger')}>
          <SettingsRow
            title={t('settings.close')}
            description={t('settings.closeNote')}
            control={
              <Button size="sm" variant="danger" onClick={requestAssistantClose} data-testid="assistant-settings-close">
                {t('settings.closeAction')}
              </Button>
            }
          />
        </SettingsGroup>
      )}
    </>
  )
}

const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const ASSISTANT_SLOT_PREFIX = 'assistant:'

/**
 * #7199 「助理」App 在壳这一侧的那一半(见 lib/assistantShellBridge.ts):把云电脑、个人助理是谁发布给会话页,
 * 并把壳自己的组件画进 App 留的格子。挂在 MainLayout 里(通讯录、设备、登录态都在它外面)。
 */
export function AssistantShellHost({ visible, ...chatHandlers }: { /** 会话页那一屏此刻摆在眼前(MainLayout 的 tab 在「任务」)。 */ visible: boolean } & AssistantChatHandlers) {
  const { user } = useAuth()
  const { contacts, contactsStatus, updateAgentProfile } = useContactsStore()
  const { cloudComputer, devices } = useDevicesStore()
  const snapshot = cloudComputer?.snapshot ?? null
  const cloudDeviceId = snapshot?.deviceId ?? null
  // 按库里的标记认(lib/myAssistant.ts),❌ 按名字、❌ 按住在哪台:会员住云上、非会员住自己的电脑,它会搬家。
  const mine = useMyAssistantContact(contacts)
  const contact = mine.contact
  // 和它的那条私聊:聊天格子画它,「今天」页读它的文件夹 —— 同一条,在这里认一次。
  const dm = useAssistantDm(contact?.id ?? null)
  const [lookOpen, setLookOpen] = useState(false)
  const ownerUserId = user?.id ?? null
  const readyCloudDeviceId = snapshot?.state === 'awake' ? snapshot.deviceId : null
  useEffect(() => {
    // A retry completes the same provision and identity: the contacts key can
    // remain unchanged. Re-read its marker when the host reports completion.
    if (ownerUserId && readyCloudDeviceId) reloadMyAssistant(ownerUserId)
  }, [ownerUserId, readyCloudDeviceId])
  useEffect(() => {
    const bridge = readAssistantShellBridge()
    if (!bridge) return
    bridge.setActions({
      renameAssistant: async (name) => {
        if (!contact) throw new Error('personal assistant is not in contacts')
        await updateAgentProfile(contact.id, { name })
      },
      openLook: () => setLookOpen(true),
      refreshCloud: () => void refreshCloudComputer().catch(() => undefined),
      advanceSetup: (next) => {
        if (ownerUserId) writeSetupStep(ownerUserId, next === 'shell' ? null : next)
      },
    })
    return () => bridge.setActions(null)
  }, [contact, updateAgentProfile, ownerUserId])
  // 这台电脑能不能当它的家:桌面版(有本机运行时)才行,网页 / 手机装不了它。
  const localDeviceId = platform.capabilities.agentRuntime ? devices.find((d) => d.is_current_device)?.device_id ?? null : null
  const home = useMemo(() => (contact ? assistantHomePlace(mine.homeDeviceId, devices, cloudDeviceId) : null), [contact, mine.homeDeviceId, devices, cloudDeviceId])

  const assistantState = assistantIdentityState(contact !== null, mine, contactsStatus)
  // 会员档:最左栏入口在「还没有咕咕」时按它写提示;读不到 = null(不当成非会员)。
  const [member, setMember] = useState<boolean | null>(null)
  useEffect(() => {
    if (!ownerUserId || !cloudComputerEnabled()) return
    let cancelled = false
    getMembership()
      .then((m) => !cancelled && setMember(!!m && m.tier !== 'free'))
      .catch((error: unknown) => {
        log.warn({ error: String(error) }, 'read membership failed')
        if (!cancelled) setMember(null)
      })
    return () => {
      cancelled = true
    }
  }, [ownerUserId])
  // 本机正在给它安家:那一次的恢复记录在(建好或失败才清);云上正在开 = 管家说 provisioning。
  const [localPreparing, setLocalPreparing] = useState(false)
  useEffect(() => {
    if (contact || !ownerUserId) {
      setLocalPreparing(false)
      return
    }
    const tick = () => {
      try {
        setLocalPreparing(!!pendingLocalAssistant(ownerUserId))
      } catch {
        setLocalPreparing(false)
      }
    }
    tick()
    const timer = window.setInterval(tick, 2000)
    return () => window.clearInterval(timer)
  }, [contact, ownerUserId])
  const preparing = !contact && (snapshot?.state === 'provisioning' || localPreparing)
  // 它已经有了、这台电脑上那一次开通却没走完(开通页没等到它起来):接着推完,让它先开口(见 lib/assistantSetupFinish)。
  const contactId = contact?.id ?? null
  useEffect(() => {
    if (!contactId || !ownerUserId || !localDeviceId) return
    return keepFinishingLocalAssistant({
      pending: () => pendingLocalAssistant(ownerUserId),
      resume: resumeLocalAssistant,
      // 只有「还没起来」值得过一会儿再推;别的失败(真失败、那一单已被收回……)再推也一样,停下、原因进日志,下次打开 App 再试。
      isFinal: (error) => !setupStillStarting(error),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      warn: (detail, message) => log.warn(detail, message),
    })
  }, [contactId, ownerUserId, localDeviceId])
  // 引导走到哪一步(记在这台电脑上):还没有它 = 前半(欢迎 → 起名 → 称呼 → 安家);安好之后接着连应用 → 一切就绪。
  const storedStep = useSyncExternalStore(
    subscribeSetupStep,
    () => readSetupStep(ownerUserId),
  )
  const setup: AssistantSetupStep | null = contact ? storedStep : assistantState === 'none' ? 'shell' : null
  useEffect(() => {
    publishAssistantShell({
      cloudAvailable: !!cloudComputer?.available,
      canHostHere: !!localDeviceId,
      cloud: snapshot,
      loadError: cloudComputer?.loadError ? String(cloudComputer.loadError) : null,
      assistant: contact ? { id: contact.id, display_name: contact.display_name, avatar: contact.avatar, created_at: contact.created_at ?? null } : null,
      assistantState,
      ownerName: user?.nickname ?? null,
      chatId: dm.chatId,
      home,
      setup,
      member,
      preparing,
    })
  }, [cloudComputer?.available, cloudComputer?.loadError, localDeviceId, snapshot, contact, assistantState, user?.nickname, dm.chatId, home, setup, member, preparing])

  const shellSlots = readShellSlots()
  const slots = useSyncExternalStore(
    (listener) => shellSlots?.subscribeSlots(listener) ?? (() => undefined),
    () => shellSlots?.getSlots() ?? EMPTY_SLOTS,
  )

  const content = (slot: AssistantShellSlot): ReactNode => {
    switch (slot) {
      case 'onboarding': return <OnboardingSlot />
      // 格子挂着 = 「助理」App 开在「聊天」那一页;再加上会话页那一屏摆在眼前,才算人在看。
      case 'chat': return contact ? <AssistantChatSlot dm={dm} assistantId={contact.id} assistantName={contact.display_name} visible={visible} {...chatHandlers} /> : null
      case 'devices': return <AssistantDevicesPage cloudDeviceId={cloudDeviceId} />
      case 'connectors': return <ConnectorsSection />
      case 'settings': return <AssistantSettingsPage />
    }
  }
  return (
    <>
      {[...slots].flatMap(([key, element]) => key.startsWith(ASSISTANT_SLOT_PREFIX)
        ? [createPortal(content(key.slice(ASSISTANT_SLOT_PREFIX.length) as AssistantShellSlot), element, key)]
        : [])}
      {lookOpen && contact ? <AgentSettingsModal agent={contact} initialTab="look" onClose={() => setLookOpen(false)} /> : null}
      {/* 搬家的弹窗:搬着时设置页上的搬家那一组会换位置、重挂,弹窗不跟着丢(状态在 assistant-move-controller)。 */}
      <AssistantMoveDialog />
      {/* 会议提醒(语音笔记):有个人助理才看日历 —— 录下的要交给它整理。 */}
      <MeetingReminder enabled={!!contact} />
      {/* 快速聊天:全局快捷键叫出的那扇小窗(只在桌面版;没有它时小窗里说怎么开通)。 */}
      <QuickChatHost
        assistant={contact ? { id: contact.id, display_name: contact.display_name, avatar: contact.avatar } : null}
        assistantState={assistantState}
        chatId={dm.chatId}
        chatFailed={dm.failed}
        chatError={dm.error}
        retryChat={dm.retry}
      />
    </>
  )
}
