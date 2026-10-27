import { assistantApplicationCounts } from '@/components/assistant/assistant-app-connections'
import { useChatChannels } from '@/components/settings/channels/useChatChannels'
import { AssistantNameInline } from '../../components/assistant/AssistantNameInline'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceMachineFor, deviceMachines } from '@/lib/deviceMachines'
import { withoutAssistantHome } from '@/lib/assistantHome'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/Avatar'
import { Markdown } from '@/components/markdown/Markdown'
import { AssistantSettingsPage } from '@/components/assistant/AssistantSettingsPage'
import { AssistantDevicesPage } from '@/components/devices/AssistantDevicesPage'
import { ChevronRight, Link, Monitor, Pencil } from '@/lib/icons'
import { AssistantDiaryDetail, AssistantDiaryList } from '@/session/renderer/features/assistant/assistant-diary'
import { AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConnectorDetail, PhoneConnectorsPage } from './PhoneConnectors'
import { PhoneConnectorSetupPage } from './PhoneConnectorSetup'
import { PhoneCustomize } from './PhoneCustomize'
import { PhoneLibraryVolume } from './PhoneLibraryVolume'
import { PhoneFiles } from './PhoneFiles'
import { filesTrail } from './phoneMemoryData'
import { parseConnectorSub } from './phoneConnectorFlow'
import { personaChipKey } from './phoneProfileModel'
import { usePhoneIntegrations, usePhonePersona, type PhonePersona } from './usePhoneProfileData'
import { usePhoneToday } from './usePhoneToday'
import './phone-profile.css'
import { AssistantLibraryCard } from '@/components/assistant/AssistantLibraryVolume'

/** Profile home: identity, projects, devices, capabilities and connected apps. */
export function PhoneProfile(props: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const settings = useTranslation('settings').t
  const devices = useDevicesStore()
  const { assistant, chatId, askInChat, sub, go, machine, cloudDeviceId } = props
  const name = assistant.display_name
  const diaries = usePhoneToday(chatId)
  const persona = usePhonePersona(machine)
  const connectors = !sub || sub === 'channels' || sub === 'connectors' || !!sub.startsWith('connector:')
  const integrations = usePhoneIntegrations(machine, connectors)
  if (sub === 'library:workspace') return <PhoneLibraryVolume key={sub} {...props} kind="workspace" />
  if (sub === 'library:capabilities' || sub === 'library:devices') return <PhoneLibraryVolume key={sub} {...props} kind={sub === 'library:capabilities' ? 'capabilities' : 'devices'} />

  if (sub === 'settings') return <div className="ta-page ta-phone-profile"><PageHead title={t('nav.settings')} /><div className="ta-skin">
    <AssistantSettingsPage onOpenPage={(tab) => props.open({ tab })} onOpenSection={(section) => go(section)} />
  </div></div>

  if (sub === 'files' || sub?.startsWith('files:')) return <PhoneFiles key={sub} {...props} trail={filesTrail(sub)} />
  if (sub === 'customize') return <PhoneCustomize {...props} persona={persona} />
  if (sub === 'connectors') return <PhoneConnectorsPage {...props} integrations={integrations} />
  if (sub?.startsWith('connector:')) {
    // `connector:<id>` 详情,`connector:<id>:connect` 连接页(返回箭头回详情,见 assistant-context.parentRoute)。
    const route = parseConnectorSub(sub)
    if (route?.view === 'connect') return <PhoneConnectorSetupPage {...props} integrations={integrations} id={route.id} />
    return <PhoneConnectorDetail {...props} integrations={integrations} id={route?.id ?? sub.slice('connector:'.length)} />
  }
  if (sub === 'devices' || sub?.startsWith('devices:')) {
    const openedDeviceId = sub.startsWith('devices:') ? sub.slice('devices:'.length) : null
    const machine = deviceMachineFor(deviceMachines([...devices.devices, ...(devices.phones ?? [])]), openedDeviceId)
    const opened = machine?.device
    const title = openedDeviceId === 'this-phone' || (machine?.current && opened && isPhoneDevice(opened))
      ? settings('devices.assistantPage.phoneTitle') : opened?.label ?? t('library.devices')
    return (
      <div className="ta-page ta-phone-profile" data-testid="assistant-slot-devices">
        <PageHead title={title} />
        <div className="ta-skin">
          <AssistantDevicesPage cloudDeviceId={cloudDeviceId} openedDeviceId={openedDeviceId} onOpenDevice={(id) => go(id ? `devices:${id}` : 'devices')} />
        </div>
      </div>
    )
  }
  if (sub === 'channels') return <PhoneConnectorsPage {...props} integrations={integrations} />
  if (sub === 'diaries') return <AssistantDiaryList view={diaries} name={name} askInChat={askInChat} open={(id) => go(`diary:${id}`)} />
  if (sub?.startsWith('diary:'))
    return (
      <AssistantDiaryDetail
        view={diaries}
        name={name}
        askInChat={askInChat}
        id={sub.slice('diary:'.length)}
        renderMarkdown={(markdown) => <Markdown trust="chat" content={markdown} />}
      />
    )
  return <ProfileHome {...props} persona={persona} integrations={integrations} />
}

function ProfileHome({
  assistant,
  go,
  persona,
  integrations,
  ...props
}: PhonePageProps & { persona: PhonePersona; integrations: ReturnType<typeof usePhoneIntegrations> }) {
  const { machine } = props
  const { updateAgentProfile } = useContactsStore()
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  const devices = useDevicesStore()
  const deviceCount = deviceMachines(withoutAssistantHome([...devices.devices, ...(devices.phones ?? [])], props.cloudDeviceId ?? null)).length
  const chats = useChatChannels()
  const counts = integrations.data && (chats.status === 'ready' || chats.status === 'not_open') ? assistantApplicationCounts(integrations.data.items, integrations.data.configured, integrations.data.statuses, chats.list) : null
  const appsDetail = integrations.error ? t('connectors.loadFailed') : !counts ? undefined : t(counts.saved > counts.connected ? 'connectors.savedCount' : 'connectors.connectedCount', { count: counts.saved > counts.connected ? counts.saved : counts.connected })
  const devicesDetail = devices.error ? t('library.failed') : devices.loading ? t('library.loading') : t('connectors.deviceCount', { count: deviceCount })
  return (
    <div className="ta-page ta-phone-profile" data-testid="assistant-profile">
      <PageHead title={t('nav.profile')} />
      <div className="ta-hero ta-phone-hero">
        <Button variant="ghost" className="ta-hero-avatar" onClick={() => go('customize')} aria-label={t('customize.title')} data-testid="assistant-profile-edit">
          <Avatar name={name} avatarUrl={assistant.avatar} seed={assistant.id} size={72} isAgent harnessBadge={false} />
          <span className="ta-hero-edit">
            <Pencil />
          </span>
        </Button>
        <div className="ta-hero-name" data-testid="assistant-name">
          <AssistantNameInline key={assistant.id} name={name} onCommit={(name) => updateAgentProfile(assistant.id, { name })} />
        </div>
        {/* 性格未读到时保留中性名称，不把读取失败当作尚未设置。 */}
        <Button variant="ghost" className="ta-chip" onClick={() => go('customize')} data-testid="assistant-character-chip">
          {t(personaChipKey(persona.persona))}
          <ChevronRight />
        </Button>
      </div>

      <AssistantSection testId="assistant-profile-entries">
        <AssistantLibraryCard assistantId={assistant.id} machine={machine.state === 'ready' ? machine.machine : null} kind="workspace" onOpen={() => go('library:workspace')} />
        <AssistantRow leading={<Monitor />} title={t('library.devices')} detail={devicesDetail} onClick={() => go('devices')} testId="assistant-library-devices" />
        <AssistantLibraryCard assistantId={assistant.id} machine={machine.state === 'ready' ? machine.machine : null} kind="capabilities" onOpen={() => go('library:capabilities')} />
        <AssistantRow leading={<Link />} title={t('connectors.title')} detail={appsDetail} onClick={() => go('connectors')} testId="assistant-open-connectors" />
      </AssistantSection>
    </div>
  )
}
