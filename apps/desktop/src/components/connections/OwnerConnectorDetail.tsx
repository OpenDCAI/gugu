import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SettingsGroup,SettingsPage,SettingsRow } from '@/components/settings/SettingsPrimitives'
import { AppConnectionHero } from '@/components/assistant/AppConnectionHero'
import { assistantAccountDisplayName,type AssistantConnectedApp } from '@/components/assistant/assistant-app-connections'
import { WechatAppConnection } from '@/components/settings/channels/WechatAppConnection'
import { useDevicesStore } from '@/store/devicesContext'
import { ChevronLeft } from '@/lib/icons'
import { IntegrationIcon } from '@/session/renderer/features/integrations/integration-icon'
import { useIntegrationsContext } from '@/session/renderer/features/integrations/integrations-provider'
import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { useShowModal } from '@/session/renderer/lib/modal/modal-provider'
import { PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import type { ConnectionMetadataItem } from './connection-metadata'
import { notify } from '@/lib/notices'
import { connectionActionNoticeScope,reportConnectionActionFailure } from './connection-action-notice'
import { connectionReadOptions } from './connection-read-policy'
import { useConnectionMutationAllowed } from './connection-mutation-context'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'

export function OwnerConnectorDetail({ host,app,deviceId,panelNavigation,onBack }: {
  host: LibraryHost; app: AssistantConnectedApp; deviceId: string | null; panelNavigation: boolean; onBack(): void
}) {
  const { t } = useTranslation('assistant'),copy = useTranslation('connections').t
  const devices = useDevicesStore(),data = useIntegrationsContext()
  const canMutate = useConnectionMutationAllowed()
  const allowed = canMutate && !(app.connectionStatus && app.state === 'checking')
  const [busy,setBusy] = useState<string | null>(null)
  const showSetup = useShowModal('integrationSetupModal'),showGithub = useShowModal('githubConnectModal'),showConfirm = useShowModal('confirmActionModal')
  const accounts = useQuery({ queryKey: ['owner-connection-accounts',host.key,app.id],enabled: !!host.connectionMetadata,
    queryFn: async () => (await host.connectionMetadata!.collection('integrations')).filter(row => row.data.providerId === app.id && typeof row.data.accountId === 'string'),
    initialData: () => host.connectionMetadata?.peekSnapshot?.()?.items.filter(row => !row.deleted_at && row.data.providerId === app.id && typeof row.data.accountId === 'string'),
    refetchOnWindowFocus: true,...connectionReadOptions })
  const where = (row: ConnectionMetadataItem) => row.source?.scopeKey === 'platform' ? copy('platform')
    : devices.devices.find(device => device.device_id === row.device_id)?.label || copy('device')
  const mutate = async (row: ConnectionMetadataItem,operation: 'remove' | 'default') => {
    const after = connectionActionNoticeScope()
    setBusy(row.resource_key)
    try {
      if (operation === 'remove') await host.connectionMetadata!.change(row,'remove')
      else await host.connectionMetadata!.save(row,{ providerId: row.data.providerId,accountId: row.data.accountId,isDefault: true })
    } catch (failure) { reportConnectionActionFailure(failure,{ ownerId: host.connectionMetadata?.ownerId,provider: app.id,after,
      title: copy(operation === 'remove' ? 'disconnectFailed' : 'defaultFailed',{ name: app.name }) }) }
    finally { setBusy(null); data.reloadConnections(); void accounts.refetch() }
  }
  const connect = () => {
    const platform = app.integration?.auth.methods.some(method => (method.kind === 'form' || method.kind === 'mcp-oauth') && method.custody === 'platform')
    if (!platform && !deviceId) { notify({ tier: 'error',title: copy('chooseAppDevice',{ name: app.name }) }); return }
    if (app.id === 'github') showGithub({ host })
    else showSetup({ integration: app.id,host })
  }
  return <SettingsPage data-testid="owner-connector-detail">
    {!panelNavigation ? <div><Button size="sm" variant="ghost" onClick={onBack}><ChevronLeft size={16} />{t('connectors.title')}</Button></div> : null}
    <PageHead title={app.name} />
    {app.integration ? <AppConnectionHero icon={<IntegrationIcon provider={app.id} icon={app.integration.icon} size={56} />}
      description={app.description} label={t(app.saved ? 'connectors.reconnect' : 'connectors.connect')} onConnect={connect} disabled={!allowed} /> : null}
    {app.id === 'wechat' ? <fieldset className="contents" disabled={!allowed}><WechatAppConnection /></fieldset> : null}
    {app.connectionStatus ? <p role="status">{app.name} · {app.connectionStatus}</p> : null}
    {!accounts.data ? <AppConnectionListPlaceholder /> : null}
    {accounts.data?.length ? <SettingsGroup title={copy('accounts')}>
      {accounts.data.map(row => <SettingsRow key={JSON.stringify([host.connectionMetadata?.ownerId,row.resource_key])}
        title={assistantAccountDisplayName(row.data.displayName) ?? assistantAccountDisplayName((row.data.publicMetadata as { login?: unknown } | undefined)?.login) ?? app.name}
        description={row.source?.scopeKey === 'platform' ? copy('onPlatform') : copy('onDevice',{ device: where(row) })}
        stack control={<div className="flex flex-wrap items-center gap-2">
          {app.id === 'github' ? row.data.isDefault ? <span className="text-xs text-foreground-muted">{copy('defaultAccount')}</span>
            : <Button size="sm" variant="ghost" disabled={!allowed || busy !== null} onClick={() => void mutate(row,'default')}>{copy('makeDefault')}</Button> : null}
          <Button size="sm" variant="danger" disabled={!allowed || busy !== null} onClick={() => showConfirm({
            title: copy('disconnectTitle',{ name: app.name }),description: copy('disconnectBody',{ where: where(row) }),confirmLabel: copy('disconnect'),
            onSuccess: () => mutate(row,'remove'),
          })}>{copy('disconnect')}</Button>
        </div>} />)}
    </SettingsGroup> : null}
  </SettingsPage>
}
