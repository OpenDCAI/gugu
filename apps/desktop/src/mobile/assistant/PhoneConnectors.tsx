import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Cloud } from '@/lib/icons'
import { platform } from '@/platform'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { integrationErrorText } from '@/session/renderer/features/integrations/integration-display'
import { connectorState } from '@/session/renderer/features/assistant/assistant-connector-status'
import { accountNoteFor } from '@/session/renderer/features/assistant/assistant-home-integrations'
import { formMethodOf } from '@/session/renderer/features/integrations/integration-setup-model'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { PluginIcon } from '@/session/renderer/lib/components/plugin-icon'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { ReadingNow } from './PhoneMachineView'
import {
  connectSub,
  formatDay,
  setupPlanOf,
} from './phoneConnectorFlow'
import { connectorDetail } from './phoneProfileModel'
import { connectorOrder } from '@/session/renderer/features/assistant/assistant-connector-order'
import { assistantConnectedApps, chatAppConnected, chatKindForApp, type AssistantConnectedApp } from '@/components/assistant/assistant-app-connections'
import { useChatChannels } from '@/components/settings/channels/useChatChannels'
import { ChannelAppConnection } from '@/components/settings/channels/ChannelAppConnection'
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon'
import { usePhoneConnectorAccounts, type ConnectorAccountRow } from './usePhoneConnectorAccounts'
import { usePhoneIntegrationDetail,type PhoneIntegrations,type usePhoneIntegrations } from './usePhoneProfileData'
import './phone-connector.css'
import { ReadFailed } from './PhoneMachineView'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

type Integrations = ReturnType<typeof usePhoneIntegrations>
/** Apps open their details before authorization; device access lives in the device section. */
export function PhoneConnectorsPage({ assistant, home, go, integrations, embedded = false }: PhonePageProps & { integrations: Integrations; embedded?: boolean }) {
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  return (
    <div className={embedded ? 'ta-phone-connectors-inline' : 'ta-page ta-phone-profile ta-phone-connectors-page'} data-testid="assistant-connectors">
      {!embedded ? <PageHead title={t('connectors.title')} sub={t('connectors.pageSub', { name })} /> : null}
      {!embedded ? <p className="ta-page-sub ta-pad">{home ? accountNoteFor(home, name, t) : t('connectors.pageSub', { name })}</p> : null}
      <CloudGate integrations={integrations}>
        {(data) => <ConnectorLists data={data} open={(id) => go(`connector:${id}`)} />}
      </CloudGate>
    </div>
  )
}

/** 云端那一份读到之前说清是哪一步:在休息 / 正在醒 / 连不上 → 读失败(带原因与重试)→ 正在读。❌ 读不到时画一个空列表。 */
export function CloudGate({
  integrations,
  children,
}: {
  integrations: Integrations
  children: (data: PhoneIntegrations) => ReactNode
}) {
  const { t } = useTranslation('assistant')
  const body = (() => {
    if (integrations.error) return <ReadFailed title={t('connectors.loadFailed')} error={integrations.error} onRetry={integrations.retry} />
    if (!integrations.data) return <ReadingNow />
    return children(integrations.data)
  })()
  return body
}

export function ConnectorIcon({ integration, size }: { integration: IntegrationMetadata; size: number }) {
  return integration.icon ? <PluginIcon id={integration.id} icon={integration.icon} size={size} /> : null
}

function ConnectorLists({ data, open }: { data: PhoneIntegrations; open: (id: string) => void }) {
  const { t, i18n } = useTranslation('assistant')
  const settings = useTranslation('settings').t
  const chats = useChatChannels()
  const apps = assistantConnectedApps(connectorOrder(data.items, i18n.language), chats.list, kind => settings(`channels.${kind}`), t('connectors.chatDescription'))
  const stateFor = (app: AssistantConnectedApp) => connectorState(!!data.configured[app.id], data.statuses?.[app.id], data.statusError, true)
  const connected = (app: AssistantConnectedApp) => chatAppConnected(app) || !!app.integration && stateFor(app) === 'connected'
  const saved = (app: AssistantConnectedApp) => !!data.configured[app.id] || !!app.channel
  const groups = [
    { key: 'connected', title: t('connectors.connected'), items: apps.filter(connected) },
    { key: 'saved', title: t('connectors.savedGroup'), items: apps.filter(app => !connected(app) && saved(app)) },
    { key: 'available', title: t('connectors.availableGroup'), items: apps.filter(app => !connected(app) && !saved(app)) },
  ]
  return <>{groups.filter(group => group.items.length).map(group => <AssistantSection key={group.key} title={group.title} testId={`assistant-connectors-${group.key}`}>
    {group.items.map(app => <AssistantRow key={app.id} testId={`assistant-connector-${app.id}`}
      leading={app.integration ? <ConnectorIcon integration={app.integration} size={32} /> : app.chatKind ? <ChannelBrandIcon kind={app.chatKind} size={32} /> : undefined}
      title={app.name} detail={app.description || <span aria-hidden="true">&nbsp;</span>} detailLines={1}
      trailing={group.key === 'saved' ? <span>{t(`connectors.${app.integration ? stateFor(app) : app.channel?.health.state === 'starting' ? 'checking' : 'needsReauth'}`)}</span> : undefined}
      chevron={group.key !== 'saved'} onClick={() => open(app.id)} />)}
  </AssistantSection>)}</>
}

/**
 * 一家的详情(照桌面 ConnectorDetail):图标、名字、介绍、一个主按钮(连接 / 重新连接 → 连接页)、连接状态、账号、在哪能用。
 * 手机上连得了的都能连(表单 / 浏览器授权 / 命令行 / GitHub 设备码,各自怎么做见 phoneConnectorFlow.ts);
 * 只有这条路手机上真走不通的才如实说去哪连(phone 网页版的浏览器授权:要 App),❌ 摆一个点了不连的钮。
 * 多账号(邮箱)与 GitHub 逐个列账号、逐个断开;单账号的一家一个「断开连接」。断开都先确认。
 */
export function PhoneConnectorDetail({ assistant, homeDeviceId, machine, integrations, id, go }: PhonePageProps & { integrations: Integrations; id: string }) {
  const { t } = useTranslation('assistant')
  const name = assistant.display_name
  const settings = useTranslation('settings').t
  const chatKind = chatKindForApp(id)
  const selected = integrations.data?.items.find(item => item.id === id)
  const detail = usePhoneIntegrationDetail(machine,selected)
  const view = integrations.data && detail.data ? connectorDetail([detail.data],integrations.data.configured,integrations.data.statuses,id) : null
  const plan = view ? setupPlanOf(view.item, platform.kind) : null
  const wantsAccounts = !!view && view.connected && (view.item.id === 'github' || view.item.multiAccount)
  const [changes, setChanges] = useState(0)
  const accounts = usePhoneConnectorAccounts({
    machine: machine.state === 'ready' ? machine.machine : null,
    device: homeDeviceId,
    id,
    name: view?.item.name ?? id,
    enabled: wantsAccounts,
    refreshKey: changes,
  })
  // 那台机器比多账号老:按单账号画(一个「断开连接」);读失败 / 还在读时不画它 —— 那个钮会一次断掉所有账号。
  const listsAccounts = wantsAccounts && accounts.supported
  const [confirm, setConfirm] = useState<{ accountId: string | null; label: string } | null>(null)
  const status = view && integrations.data?.statuses ? integrations.data.statuses[view.item.id] : undefined
  const state = connectorState(view?.connected, status, integrations.data?.statusError,true)
  const issueText = view && status && !status.connected && view.connected ? integrationErrorText(translateSessionMessage, view.item.name, status) : undefined

  const disconnect = async () => {
    if (!view || machine.state !== 'ready' || !machine.machine.panel || !confirm) return
    const panel = machine.machine.panel
    const rows = await panel.collection('integrations')
    for (const row of rows.filter(row => row.data.providerId === view.item.id && typeof row.data.accountId === 'string'
      && (!confirm.accountId || row.data.accountId === confirm.accountId))) await panel.change(row,'remove')
    await reportAssistantAppChange(machine.machine, assistant.id, { resource: 'integrations', operation: 'removed', section: 'accounts',
      id: confirm.accountId ? `${view.item.id}:${confirm.accountId}` : view.item.id, deviceId: homeDeviceId ?? undefined })
  }
  const credentialLike = !!view && !!formMethodOf(view.item)
  if (integrations.data && !selected && chatKind) return <div className="ta-page ta-phone-profile" data-testid="assistant-connector-detail"><PageHead title={settings(`channels.${chatKind}`)} /><ChannelAppConnection kind={chatKind} name={settings(`channels.${chatKind}`)} /></div>

  return (
    <div className="ta-page ta-phone-profile" data-testid="assistant-connector-detail">
      <PageHead title={view?.item.name ?? t('connectors.title')} />
      <CloudGate integrations={integrations}>
        {() =>
          detail.error ? <ReadFailed title={t('connectors.loadFailed')} error={detail.error} onRetry={detail.reload} /> : detail.loading ? <ReadingNow /> : view ? (
            <>
              {id === 'feishu' || chatKind ? <h2 className="ta-section-label">{t('connectors.readWritePurpose', { app: view.item.name })}</h2> : null}
              <div className="ta-card ta-connector-hero">
                <ConnectorIcon integration={view.item} size={56} />
                <span className="ta-page-sub">{view.item.description}</span>
                {plan && plan.kind !== 'unavailable' ? (
                  <Button variant="ghost" className="ta-solid-btn" disabled={state === 'checking'} onClick={() => go(connectSub(view.item.id))} data-testid="assistant-connector-connect">
                    {view.connected ? (view.item.multiAccount || view.item.id === 'github' ? t('connectors.addAccount') : t('connectors.reconnect')) : t('connectors.connect')}
                  </Button>
                ) : (
                  <p className="ta-phone-connect-note" data-testid="assistant-connector-connect-note">
                    {plan?.reason === 'needs-app'
                      ? t('connectors.connectInApp', { name: view.item.name })
                      : view.connected
                        ? t('connectors.reconnectOnDesktop')
                        : t('connectors.connectOnDesktop')}
                  </p>
                )}
              </div>
              {view.connected ? <AssistantSection title={t('connectors.connection', { name: view.item.name })}>
                <AssistantRow
                  title={t('connectors.status')}
                  detail={issueText}
                  trailing={
                    <span className={state === 'connected' ? 'ta-ok' : state === 'needsReauth' || state === 'checkFailed' ? 'ta-phone-warn' : undefined}>
                      {t(`connectors.${state}`)}
                    </span>
                  }
                />
                {view.account && !listsAccounts ? <AssistantRow title={t('connectors.account')} trailing={view.account} /> : null}
              </AssistantSection> : null}
              {listsAccounts && accounts.accounts?.length ? (
                <AssistantSection title={t('connectors.accounts')} testId="assistant-connector-accounts">
                  {accounts.accounts.map((account) => (
                    <AccountRow key={account.accountId} account={account} onDisconnect={() => setConfirm({ accountId: account.accountId, label: account.label })} />
                  ))}
                </AssistantSection>
              ) : null}
              {listsAccounts && accounts.error ? <ReadFailed title={t('connectors.accountsFailed')} error={accounts.error} onRetry={accounts.reload} /> : null}
              {view.connected && !listsAccounts ? (
                <Button variant="ghost" className="ta-wide-btn" data-tone="danger" onClick={() => setConfirm({ accountId: null, label: view.item.name })} data-testid="assistant-connector-disconnect">
                  {t('connectors.disconnect')}
                </Button>
              ) : null}
              {chatKind ? <ChannelAppConnection kind={chatKind} name={view.item.name} /> : null}
              <AssistantSection title={t('connectors.usableOn')}>
                <AssistantRow leading={<Cloud className="ta-file-icon" />} title={t('connectors.cloudWhere')} detail={t('connectors.cloudWhereNote', { name })} />
              </AssistantSection>
              <PhoneConfirmDialog
                  open={confirm !== null}
                  title={confirm?.accountId ? t('connectors.disconnectAccountTitle', { account: confirm?.label ?? '' }) : t('connectors.disconnectTitle', { name: view.item.name })}
                  body={
                    confirm?.accountId
                      ? t('connectors.disconnectAccountBody', { account: confirm?.label ?? '' })
                      : `${t('connectors.disconnectBody', { name: view.item.name, assistant: name })}${credentialLike ? t('connectors.disconnectCredentials', { name: view.item.name }) : ''}`
                  }
                  confirmLabel={t('connectors.disconnect')}
                  failedText={t('connectors.disconnectFailed')}
                  onConfirm={disconnect}
                  onConfirmed={() => { integrations.retry(); setChanges((n) => n + 1) }}
                  onClose={() => setConfirm(null)}
                  testId="assistant-connector-disconnect-dialog"
                />

            </>
          ) : (
            <AssistantEmpty title={t('connectors.goneTitle')}>{t('connectors.gone')}</AssistantEmpty>
          )
        }
      </CloudGate>
    </div>
  )
}

/** 多账号里的一行:谁(账号名 / 邮箱 / @login)、连接于哪天,右边一个「断开」。 */
function AccountRow({ account, onDisconnect }: { account: ConnectorAccountRow; onDisconnect: () => void }) {
  const { t } = useTranslation('assistant')
  return (
    <AssistantRow
      testId="assistant-connector-account"
      title={account.label}
      detail={account.connectedAt ? t('connectors.connectedOn', { date: formatDay(account.connectedAt) }) : undefined}
      trailing={
        <Button variant="ghost" className="ta-pill-btn" data-tone="danger" onClick={onDisconnect} data-testid="assistant-connector-account-disconnect">
          {t('connectors.disconnect')}
        </Button>
      }
    />
  )
}
