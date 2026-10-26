import { AssistantNameInline } from '../../components/assistant/AssistantNameInline'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../../store/contactsContext'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/Avatar'
import { Markdown } from '@/components/markdown/Markdown'
import { ChatChannelsPanel } from '@/components/settings/channels/ChatChannelsPanel'
import { AssistantSettingsPage } from '@/components/assistant/AssistantSettingsPage'
import { AssistantDevicesPage } from '@/components/devices/AssistantDevicesPage'
import { ChevronRight, Pencil } from '@/lib/icons'
import { AssistantDiaryDetail, AssistantDiaryList, AssistantDiarySection } from '@/session/renderer/features/assistant/assistant-diary'
import { AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConnectorDetail, PhoneConnectorsPage } from './PhoneConnectors'
import { PhoneConnectorSetupPage } from './PhoneConnectorSetup'
import { PhoneCustomize } from './PhoneCustomize'
import { PhoneLibraryVolume } from './PhoneLibraryVolume'
import { parseConnectorSub } from './phoneConnectorFlow'
import { personaChipKey } from './phoneProfileModel'
import { usePhoneIntegrations, usePhonePersona, type PhonePersona } from './usePhoneProfileData'
import { usePhoneToday } from './usePhoneToday'
import './phone-profile.css'
import { AssistantLibraryCard } from '@/components/assistant/AssistantLibraryVolume'

/**
 * <它的名字> 那一格(同桌面 assistant-profile,手机上头像通顶、没有页头):大头像(右下一支笔 = 自定义)、名字、
 * 「从某天起陪伴你」、性格胶囊、日记;直接展开应用连接和状态,设备与聊天工具点进去往下钻。
 * 改名、换形象、性格都在「自定义」那一页(手机上是推进来的一页,❌ 弹窗 / 底部抽屉)。
 * 设备、聊天工具是壳那棵树的组件(手机壳本来就在壳里,直接画),套 .ta-skin 换成助理 App 的卡与行。
 */
export function PhoneProfile(props: PhonePageProps) {
  const { t } = useTranslation('assistant')
  const { assistant, chatId, askInChat, sub, go, machine, readiness, homeDeviceId, cloudDeviceId } = props
  const name = assistant.display_name
  const diaries = usePhoneToday(chatId)
  const persona = usePhonePersona(machine)
  const connectors = !sub || sub === 'connectors' || !!sub.startsWith('connector:')
  const integrations = usePhoneIntegrations(homeDeviceId, readiness, connectors)
  if (sub === 'library:capabilities' || sub === 'library:devices') return <PhoneLibraryVolume key={sub} {...props} kind={sub === 'library:capabilities' ? 'capabilities' : 'devices'} />

  if (sub === 'settings') return <div className="ta-page ta-phone-profile"><PageHead title={t('nav.settings')} /><div className="ta-skin">
    <AssistantSettingsPage onOpenPage={(tab) => props.open({ tab })} onOpenSection={(section) => go(section)} />
  </div></div>

  if (sub === 'customize') return <PhoneCustomize {...props} persona={persona} />
  if (sub === 'connectors') return <PhoneConnectorsPage {...props} integrations={integrations} />
  if (sub?.startsWith('connector:')) {
    // `connector:<id>` 详情,`connector:<id>:connect` 连接页(返回箭头回详情,见 assistant-context.parentRoute)。
    const route = parseConnectorSub(sub)
    if (route?.view === 'connect') return <PhoneConnectorSetupPage {...props} integrations={integrations} id={route.id} />
    return <PhoneConnectorDetail {...props} integrations={integrations} id={route?.id ?? sub.slice('connector:'.length)} />
  }
  if (sub === 'devices')
    return (
      // 设备那一页(AssistantDevicesPage)自己带标题和说明,这里不再叠一层(与桌面同)。
      <div className="ta-page ta-phone-profile" data-testid="assistant-slot-devices">
        <div className="ta-skin">
          <AssistantDevicesPage cloudDeviceId={cloudDeviceId} />
        </div>
      </div>
    )
  if (sub === 'channels')
    return (
      <div className="ta-page ta-phone-profile" data-testid="assistant-slot-channels">
        <PageHead title={t('channels.title')} />
        <div className="ta-skin">
          <ChatChannelsPanel />
        </div>
        {/* 聊天工具挂在咕咕云端,手机上也一样成立(电脑关着照样收得到)。 */}
        <p className="ta-page-sub ta-pad">{t('channels.desktopOnly', { name })}</p>
      </div>
    )
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
  return <ProfileHome {...props} persona={persona} diaries={diaries} integrations={integrations} />
}

function ProfileHome({
  assistant,
  ownerName,
  askInChat,
  go,
  persona,
  diaries,
  integrations,
  ...props
}: PhonePageProps & { persona: PhonePersona; diaries: ReturnType<typeof usePhoneToday>; integrations: ReturnType<typeof usePhoneIntegrations> }) {
  const { machine } = props
  const { updateAgentProfile } = useContactsStore()
  const { t, i18n } = useTranslation('assistant')
  const name = assistant.display_name
  const since = assistant.created_at
    ? new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(assistant.created_at))
    : null
  return (
    <div className="ta-page ta-phone-profile" data-testid="assistant-profile">
      <div className="ta-hero ta-phone-hero">
        <Button variant="ghost" className="ta-hero-avatar" onClick={() => go('customize')} aria-label={t('customize.title')} data-testid="assistant-profile-edit">
          <Avatar name={name} avatarUrl={assistant.avatar} seed={assistant.id} size={72} isAgent harnessBadge={false} />
          <span className="ta-hero-edit">
            <Pencil />
          </span>
        </Button>
        <h1 className="ta-hero-name" data-testid="assistant-name">
          <AssistantNameInline key={assistant.id} name={name} onCommit={(name) => updateAgentProfile(assistant.id, { name })} />
        </h1>
        {since ? <p className="ta-hero-since">{t('header.since', { date: since, name: ownerName || t('header.you') })}</p> : null}
        {/* 性格在它家里,在休息时读不到:只说「性格」,❌ 说成「设置性格」(它可能早有性格);点进去自定义那页说清怎么读。 */}
        <Button variant="ghost" className="ta-chip" onClick={() => go('customize')} data-testid="assistant-character-chip">
          {t(personaChipKey(persona.persona))}
          <ChevronRight />
        </Button>
      </div>

      <AssistantDiarySection view={diaries} name={name} askInChat={askInChat} open={(id) => go(`diary:${id}`)} openAll={() => go('diaries')} />

      <AssistantSection title={t('connectors.title')} testId="assistant-profile-connectors" bare>
        <PhoneConnectorsPage {...props} assistant={assistant} ownerName={ownerName} askInChat={askInChat} go={go} integrations={integrations} embedded />
      </AssistantSection>
      <AssistantSection title={t('capabilities.title')} testId="assistant-capabilities">
        <AssistantLibraryCard assistantId={assistant.id} machine={machine.state === 'ready' ? machine.machine : null} kind="capabilities" onOpen={() => go('library:capabilities')} />
        <AssistantLibraryCard assistantId={assistant.id} machine={machine.state === 'ready' ? machine.machine : null} kind="devices" onOpen={() => go('library:devices')} />
        <AssistantRow title={t('channels.title')} detail={t('channels.note', { name })} onClick={() => go('channels')} testId="assistant-open-channels" />
      </AssistantSection>
      {/* 它自己的设置:从前是页头的齿轮,页头只剩一行后(owner 10-26)从资料进。 */}
      <AssistantSection testId="assistant-profile-settings">
        <AssistantRow title={t('nav.settings')} onClick={() => go('settings')} testId="assistant-open-settings" />
      </AssistantSection>
    </div>
  )
}
