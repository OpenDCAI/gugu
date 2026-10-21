import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { AssistantStatusGroups, OnboardingSlot } from '../assistant/AssistantShellHost'
import { AssistantMoveGroup, type AssistantMoveGroupProps } from '../assistant/AssistantMoveGroup'
import { ComputerHomeGroups } from '../assistant/ComputerHomeSettings'
import { Avatar } from '../Avatar'
import { AssistantNameInline } from '../assistant/AssistantNameInline'
import { AgentSettingsModal } from '../agentsettings/AgentSettingsModal'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { ChevronRight, Clock, Database, Monitor, Plug, MessageCircle, Cpu } from '@/lib/icons'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { platform } from '../../platform'
import { useAuth } from '../../store/auth'
import { meetingReminderEnabled, setMeetingReminderEnabled, subscribeMeetingReminderPref } from '../../lib/meetingReminderPref'
import { invokeOnMachine } from '../../session/renderer/lib/ipc'
import { VOICE_NOTE_MEETINGS_CHANNEL, type VoiceNoteMeetingsResult } from '../../session/shared/core/voice-notes'
import { useContactsStore } from '../../store/contactsContext'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { useSyncExternalStore } from 'react'
import '../../i18n/registerAssistantCatalog'
import '../../i18n/registerVoiceNotesCatalog'

/** 助理 App 里的页(齿轮以外的数据页);设置里只放指过去的入口,❌ 在设置里再做一份。 */
export type AssistantPageTab = 'memory' | 'tasks'

/**
 * 咕咕独立设置与全局设置共用的内容，入口不同、数据相同：
 * 它是谁(名字、形象与性格)→ 它用的东西(指向本组与别组的页)→ 它的状态(醒着多久、积分、休息、快速聊天、关闭)。
 * 数据与动作都是助理 App 原来齿轮页那一份(AssistantShellHost 的状态组),这里只是换了住处。
 */
export function AssistantSection({ available, onOpenSection, onOpenAssistantPage, onOpenModel }: {
  /** 这台宿主显示的设置格(SettingsPanel 的过滤结果):指过去的入口只给存在的格。 */
  available: readonly ActiveSection[]
  onOpenSection: (section: ActiveSection) => void
  /** 打开助理 App 里的某一页(会先收起设置);手机上助理是底部 tab,不给。 */
  onOpenAssistantPage?: (tab: AssistantPageTab) => void
  onOpenModel?: () => void
}) {
  const { t } = useTranslation('assistant')
  const { updateAgentProfile } = useContactsStore()
  const { user } = useAuth()
  const { mine, contact, home, localDeviceId, snapshot, cloudDeviceId, cloudComputer, devices } = useAssistantHome()
  const device = cloudDeviceId ? devices.find((d) => d.device_id === cloudDeviceId) ?? null : null
  const name = contact?.display_name ?? t('rail')
  const move: AssistantMoveGroupProps | null =
    user?.id && contact && home && platform.capabilities.agentRuntime
      ? { ownerUserId: user.id, assistantId: contact.id, assistantName: contact.display_name, home, localDeviceId, cloudAvailable: !!cloudComputer?.available }
      : null

  const [lookOpen, setLookOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  // 还没有咕咕:一页只画「安家」的流程(会员一键领取、非会员装在这台电脑上)。认它是谁还在读 / 读不到时照实说,❌ 当成没有。
  if (!contact) {
    if (mine.loading || mine.agentId)
      return (
        <SettingsPage data-testid="settings-assistant">
          <SettingsNote>{t('identity.loading')}</SettingsNote>
        </SettingsPage>
      )
    if (mine.error)
      return (
        <SettingsPage data-testid="settings-assistant">
          <SettingsNote tone="danger">{t('identity.unreadable')}</SettingsNote>
        </SettingsPage>
      )
    return (
      <SettingsPage data-testid="settings-assistant">
        <SettingsGroup>
          <div className="gg-settings-empty">
            <OnboardingSlot />
          </div>
        </SettingsGroup>
      </SettingsPage>
    )
  }

  const link = (section: ActiveSection, title: string, description: string) =>
    available.includes(section) ? (
      <SettingsRow
        key={section}
        data-testid={`settings-assistant-open-${section}`}
        title={title}
        description={description}
        leading={section === 'devices' ? <Monitor size={16} /> : section === 'channels' ? <MessageCircle size={16} /> : <Plug size={16} />}
        control={<ChevronRight size={16} className="gg-settings-row-chevron" aria-hidden="true" />}
        onClick={() => onOpenSection(section)}
      />
    ) : null
  const page = (tab: AssistantPageTab, title: string, description: string) =>
    onOpenAssistantPage ? (
      <SettingsRow
        key={tab}
        data-testid={`settings-assistant-open-${tab}`}
        title={title}
        description={description}
        leading={tab === 'memory' ? <Database size={16} /> : <Clock size={16} />}
        control={<ChevronRight size={16} className="gg-settings-row-chevron" aria-hidden="true" />}
        onClick={() => onOpenAssistantPage(tab)}
      />
    ) : null

  return (
    <SettingsPage data-testid="settings-assistant">
      <SettingsNote>{t('settingsPage.intro', { name })}</SettingsNote>

      {/* 它是谁:头像 + 名字(就地改)+ 形象与性格(形象工坊)。 */}
      <SettingsGroup presentation="summary">
        {contact ? (
          <SettingsRow
            data-testid="settings-assistant-who"
            leading={<Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size={44} isAgent harnessBadge={false} />}
            title={<AssistantNameInline key={contact.id} name={contact.display_name} activation="double-click" onCommit={(next) => updateAgentProfile(contact.id, { name: next })} />}
            description={t('settingsPage.whoNote')}
            control={<Button size="sm" onClick={() => setLookOpen(true)} data-testid="settings-assistant-look">{t('settingsPage.look')}</Button>}
            stack
          />
        ) : null}
      </SettingsGroup>

      {/* 它记得什么 / 每天做什么:数据在助理 App 的页里,这里是入口(手机上没有这一组)。 */}
      {onOpenAssistantPage ? (
        <SettingsGroup presentation="navigation" title={t('settingsPage.knows')}>
          {page('memory', t('settings.memoryRow'), t('settings.memoryNote', { name }))}
          {page('tasks', t('settings.routinesRow'), t('settings.routinesNote', { name }))}
        </SettingsGroup>
      ) : null}

      {/* 它用的东西：各个设置入口共用同一份数据与操作。 */}
      <SettingsGroup presentation="navigation" title={t('capabilities.title')}>
        <SettingsRow
          title={t('settingsPage.model')}
          description={t('settingsPage.modelNote')}
          leading={<Cpu size={16} />}
          control={<ChevronRight size={16} className="gg-settings-row-chevron" aria-hidden="true" />}
          onClick={onOpenModel ?? (() => setModelOpen(true))}
          data-testid="settings-assistant-model"
        />
        {link('connectors', t('connectors.title'), t('connectors.note', { name }))}
        {link('devices', t('devices.title'), t('devices.note'))}
        {link('channels', t('channels.title'), t('channels.note', { name }))}
      </SettingsGroup>

      {/* 它住哪:云上是管家说的状态(醒着多久、积分、休息、叫醒、关闭)+ 搬家;住电脑是那台开没开 + 搬家。 */}
      {home?.kind === 'computer' ? (
        <ComputerHomeGroups home={home} assistantName={name} move={move} />
      ) : snapshot && (snapshot.state === 'awake' || snapshot.state === 'asleep' || snapshot.state === 'waking') ? (
        <AssistantStatusGroups snapshot={snapshot} device={device} assistantName={name} move={move} />
      ) : move ? (
        <AssistantMoveGroup {...move} />
      ) : null}
      {/* 会议提醒读的是这台电脑的日历、提醒也只在桌面弹:手机上没有这个开关(手机端咕咕页自己的事)。 */}
      {platform.capabilities.agentRuntime ? <MeetingReminderGroup /> : null}
      {lookOpen && contact ? <AgentSettingsModal agent={contact} initialTab="look" onClose={() => setLookOpen(false)} /> : null}
      {modelOpen && contact ? <AgentSettingsModal agent={contact} initialTab="aimodel" onClose={() => setModelOpen(false)} /> : null}
    </SettingsPage>
  )
}

/** 入会提醒开关(语音笔记);日历没连上就照实说要先去连。偏好存在这台电脑上(lib/meetingReminderPref)。 */
function MeetingReminderGroup() {
  const { t } = useTranslation('voiceNotes')
  const enabled = useSyncExternalStore(subscribeMeetingReminderPref, meetingReminderEnabled)
  const [calendar, setCalendar] = useState<'ok' | 'missing' | null>(null)
  useEffect(() => {
    let cancelled = false
    void (invokeOnMachine(null, VOICE_NOTE_MEETINGS_CHANNEL) as Promise<VoiceNoteMeetingsResult>)
      .then((result) => {
        if (!cancelled) setCalendar(result.ok ? 'ok' : result.code === 'not_granted' || result.code === 'unsupported' || result.code === 'os_permission' ? 'missing' : 'ok')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <SettingsGroup title={t('title')} data-testid="settings-assistant-voice">
      <SettingsRow
        title={t('meeting.setting')}
        description={calendar === 'missing' ? t('meeting.needsCalendar') : t('meeting.settingDescription')}
        control={<Switch checked={enabled} onCheckedChange={(on) => setMeetingReminderEnabled(on)} aria-label={t('meeting.setting')} data-testid="assistant-meeting-reminder-switch" />}
      />
    </SettingsGroup>
  )
}
