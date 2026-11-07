import { useMemo,useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { useDevicesStore } from '@/store/devicesContext'
import { useMobileShell } from '@/hooks/useMobileShell'
import { ConnectedAppsCatalog } from '@/components/assistant/ConnectedAppsCatalog'
import { assistantConnectedApps } from '@/components/assistant/assistant-app-connections'
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon'
import { useChatChannels } from '@/components/settings/channels/useChatChannels'
import { SettingsPage } from '@/components/settings/SettingsPrimitives'
import { IntegrationIcon } from '@/session/renderer/features/integrations/integration-icon'
import { IntegrationsProvider,useIntegrationsContext } from '@/session/renderer/features/integrations/integrations-provider'
import { LibraryHostProvider,type LibraryHost } from '@/session/renderer/features/library/library-host'
import { settingsDeviceStore,LOCAL_DEVICE_SCOPE } from '@/session/renderer/features/remote-hosts/device-scope-store'
import { connectorState } from '@/session/renderer/features/assistant/assistant-connector-status'
import { connectorOrder } from '@/session/renderer/features/assistant/assistant-connector-order'
import { useAssistantPanelBack } from '@/lib/assistantPanelPage'
import { useOwnerLibraryHost } from './useOwnerLibraryHost'
import { OwnerConnectorDetail } from './OwnerConnectorDetail'
import './connection-copy'
import { connectionApplicationStatus } from './connection-application-status'
import { useConnectionRecovery } from './useConnectionRecovery'
import { useConnectionMutationAllowed } from './connection-mutation-context'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

/** Both settings shells use the same controller without resolving an assistant. */
export const OwnerConnectorsSettings = observer(function OwnerConnectorsSettings({ panelNavigation = false,deviceId,route,initialConnectorId }: { panelNavigation?: boolean; deviceId?: string | null; route: ConnectionRoute; initialConnectorId?: string }) {
  const devices = useDevicesStore()
  const selectedId = deviceId === undefined ? settingsDeviceStore.selected : deviceId
  const device = selectedId === LOCAL_DEVICE_SCOPE ? devices.devices.find(row => row.is_current_device) ?? null
    : devices.devices.find(row => row.device_id === selectedId) ?? null
  const host = useOwnerLibraryHost(device,route)
  return <LibraryHostProvider value={host} key={host.key}><IntegrationsProvider>
    <OwnerConnectorList host={host} selectedDeviceId={device?.device_id ?? null} panelNavigation={panelNavigation} showDevicePicker={deviceId === undefined} initialConnectorId={initialConnectorId} />
  </IntegrationsProvider></LibraryHostProvider>
})

function OwnerConnectorList({ host,selectedDeviceId,panelNavigation,showDevicePicker,initialConnectorId }: { host: LibraryHost; selectedDeviceId: string | null; panelNavigation: boolean; showDevicePicker: boolean; initialConnectorId?: string }) {
  const { t,i18n } = useTranslation('assistant'),copy = useTranslation('connections').t,settings = useTranslation('settings').t
  const mobile = useMobileShell(),devices = useDevicesStore(),channels = useChatChannels()
  const data = useIntegrationsContext()
  const [openId,setOpenId] = useState<string | null>(initialConnectorId ?? null)
  useAssistantPanelBack(panelNavigation && openId ? `owner-connector:${openId}` : null,() => setOpenId(null))
  const allowed = useConnectionMutationAllowed()
  useConnectionRecovery(host.connectionMetadata,allowed)
  const apps = useMemo(() => assistantConnectedApps(connectorOrder(data.integrations,i18n.language),channels.list,
    id => settings(`channels.${id}`),t('connectors.wechatDescription'),
    id => connectorState(data.hasConfiguredConnections ? !!data.configuredConnections[id] : undefined,data.checkedConnections[id],
      undefined,true),data.configuredConnections).map(app => {
      const status = connectionApplicationStatus(host.connectionMetadata?.peekSnapshot?.(),app.id,data.connectionOperations)
      return status ? { ...app,state: status.confirming ? 'checking' as const : 'needsReauth' as const,connectionStatus: copy(status.key) } : app
    }),[data,host.connectionMetadata,i18n.language,channels.list,settings,t,copy])
  const selected = openId ? apps.find(app => app.id === openId) : null
  if (selected) return <OwnerConnectorDetail host={host} app={selected} deviceId={selectedDeviceId} panelNavigation={panelNavigation} onBack={() => setOpenId(null)} />
  return <SettingsPage data-testid="owner-connectors">
    {showDevicePicker ? <label className="flex items-center justify-between gap-3 text-sm">{copy('device')}
      <select aria-label={copy('device')} value={selectedDeviceId ?? 'connections:all'}
        onChange={event => settingsDeviceStore.select(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-foreground">
        <option value="connections:all">{copy('allDevices')}</option>
        {devices.devices.map(device => <option key={device.device_id} value={device.device_id}>{device.label || device.hostname}</option>)}
      </select>
    </label> : null}
    <ConnectedAppsCatalog apps={apps} scope={host.key} open={setOpenId} mobile={mobile} panelNavigation={panelNavigation}
      connectionRead={data.hasConfiguredConnections ? 'ready' : 'pending'}
      icon={(app,size) => app.integration ? <IntegrationIcon provider={app.id} icon={app.integration.icon} size={size} />
        : app.id === 'wechat' ? <ChannelBrandIcon kind="wechat" size={size} /> : null} />
  </SettingsPage>
}
