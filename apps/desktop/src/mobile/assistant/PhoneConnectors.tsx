import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OtherDeviceConnectors, ThisDeviceConnectors } from '@/components/devices/AssistantDeviceConnectors'
import { Button } from '@/components/ui/Button'
import { Cloud } from '@/lib/icons'
import { platform } from '@/platform'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead, WideSegments } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { integrationErrorText } from '@/session/renderer/features/integrations/integration-display'
import { connectorState } from '@/session/renderer/features/assistant/assistant-connector-status'
import { accountNoteFor } from '@/session/renderer/features/assistant/assistant-home-integrations'
import { formMethodOf } from '@/session/renderer/features/integrations/integration-setup-model'
import type { IntegrationMetadata } from '@/session/renderer/features/integrations/integrations-provider'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { PluginIcon } from '@/session/renderer/lib/components/plugin-icon'
import { PhoneDeviceActionsPage } from '../phone-device/PhoneDeviceActionsPage'
import type { PhonePageProps } from './MobileAssistantApp'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { ReadingNow } from './PhoneMachineView'
import {
  connectSub,
  formatDay,
  setupPlanOf,
} from './phoneConnectorFlow'
import { connectorDetail, connectorGroups, thisDeviceView } from './phoneProfileModel'
import { usePhoneConnectorAccounts, type ConnectorAccountRow } from './usePhoneConnectorAccounts'
import type { PhoneIntegrations, usePhoneIntegrations } from './usePhoneProfileData'
import './phone-connector.css'
import { ReadFailed } from './PhoneMachineView'
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'

type Integrations = ReturnType<typeof usePhoneIntegrations>
type Where = 'cloud' | 'device' | 'other'

/**
 * 连接应用(照桌面 assistant-capabilities,owner 10-15「连接要分清在哪」):三段 云端 / 本机 / 其他设备。
 * - 云端 = 有账号的服务,存在它家里(问那台的 integrations.*,醒着才问,❌ 自己叫醒);一行一家,点进去是详情。
 * - 本机 = 这台手机(装的咕咕:手机能做的事;网页版:说要在咕咕电脑 App 里连)。
 * - 其他设备 = 别的设备登记的动作,与桌面同一个组件。
 */
export function PhoneConnectorsPage({ assistant, home, cloudDeviceId, go, integrations, embedded = false }: PhonePageProps & { integrations: Integrations; embedded?: boolean }) {
  const { t } = useTranslation('assistant')
  const [where, setWhere] = useState<Where>('cloud')
  const name = assistant.display_name
  return (
    <div className={embedded ? 'ta-phone-connectors-inline' : 'ta-page ta-phone-profile'} data-testid="assistant-connectors">
      {!embedded ? <PageHead title={t('connectors.title')} sub={t('connectors.pageSub', { name })} /> : null}
      <WideSegments<Where>
        items={[
          { id: 'cloud', label: t('connectors.where.cloud') },
          { id: 'device', label: t('connectors.where.device') },
          { id: 'other', label: t('connectors.where.other') },
        ]}
        value={where}
        onChange={setWhere}
      />
      {where === 'cloud' ? (
        <>
          {!embedded ? <p className="ta-page-sub ta-pad">{home ? accountNoteFor(home, name, t) : t('connectors.pageSub', { name })}</p> : null}
          <CloudGate integrations={integrations}>
            {(data) => <ConnectorLists data={data} open={(id) => go(`connector:${id}`)} connect={(id) => go(connectSub(id))} />}
          </CloudGate>
        </>
      ) : (
        <div className="ta-skin" key={where}>
          {where === 'other' ? (
            <OtherDeviceConnectors cloudDeviceId={cloudDeviceId} />
          ) : thisDeviceView(platform.kind) === 'phone' ? (
            <PhoneDeviceActionsPage />
          ) : (
            <ThisDeviceConnectors />
          )}
        </div>
      )}
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

function ConnectorLists({ data, open, connect }: { data: PhoneIntegrations; open: (id: string) => void; connect: (id: string) => void }) {
  const { t, i18n } = useTranslation('assistant')
  const { connected, available } = connectorGroups(data.items, data.configured, data.statuses, i18n.language)
  const row = ({ item, detail }: { item: IntegrationMetadata; detail: string }) => {
    const configured = !!data.configured[item.id]
    const state = connectorState(configured, data.statuses?.[item.id], data.statusError,true)
    const canConnect = setupPlanOf(item, platform.kind).kind !== 'unavailable'
    return (
      <div className="ta-connector-row" key={item.id}>
        <AssistantRow
          testId={`assistant-connector-${item.id}`}
          leading={<ConnectorIcon integration={item} size={30} />}
          title={item.name}
          detail={detail}
          trailing={<span className={state === 'connected' ? 'ta-ok' : state === 'needsReauth' || state === 'checkFailed' ? 'ta-phone-warn' : undefined}>{t(`connectors.${state}`)}</span>}
          onClick={() => open(item.id)}
        />
        {canConnect && (!configured || state === 'needsReauth') ? (
          <Button variant="ghost" className="ta-pill-btn" onClick={() => connect(item.id)} data-testid={`assistant-connect-${item.id}`}>
            {t(configured ? 'connectors.reconnect' : 'connectors.connect')}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <>
      {connected.length ? (
        <AssistantSection title={t('connectors.savedGroup')} testId="assistant-connectors-connected">
          {connected.map(row)}
        </AssistantSection>
      ) : null}
      {available.length ? (
        <AssistantSection title={t('connectors.availableGroup')} testId="assistant-connectors-available">
          {available.map(row)}
        </AssistantSection>
      ) : null}
    </>
  )
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
  const view = integrations.data && !integrations.error ? connectorDetail(integrations.data.items, integrations.data.configured, integrations.data.statuses, id) : null
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

  return (
    <div className="ta-page ta-phone-profile" data-testid="assistant-connector-detail">
      <PageHead title={view?.item.name ?? t('connectors.title')} />
      <CloudGate integrations={integrations}>
        {() =>
          view ? (
            <>
              <div className="ta-card ta-connector-hero">
                <ConnectorIcon integration={view.item} size={56} />
                <span className="ta-tile-title">{view.item.name}</span>
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
              <AssistantSection title={t('connectors.connection', { name: view.item.name })}>
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
              </AssistantSection>
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
