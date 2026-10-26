import { useAssistantPanelIntegration } from '@/components/assistant/useAssistantPanelIntegration';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import { assistantConnectedApps, type AssistantConnectedApp } from '@/components/assistant/assistant-app-connections';
import { useChatChannels } from '@/components/settings/channels/useChatChannels';
import { WechatAppConnection } from '@/components/settings/channels/WechatAppConnection';
import { AppConnectionHero,AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero';
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon';
import { useAssistantPanelBack } from '@/lib/assistantPanelPage';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { Button } from '@/components/ui/Button';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { ChevronLeft, ChevronRight, Cloud, Monitor } from '@/lib/icons';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { IntegrationsProvider, useIntegrationsContext } from '@renderer/features/integrations/integrations-provider';
import { LibraryHostProvider, type LibraryHost } from '@renderer/features/library/library-host';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { connectorOrder } from './assistant-connector-order';
import { accountNoteFor, homeWhere, useHomeLibraryHost } from './assistant-home-integrations';
import { connectorState, type ConnectorState } from './assistant-connector-status';
import { useAssistantReadError, useReadFailure } from './assistant-read-failure';
import { PageHead } from './assistant-ui-parts';

type Props = { home: AssistantHomePlace; assistantName: string; panelNavigation?: boolean };
/** Same accounts and authorization paths in settings and the assistant panel. */
export const HomeConnectorsSettings = observer(function HomeConnectorsSettings({ home, assistantName, panelNavigation = false }: Props) {
  const host = useHomeLibraryHost(home);
  return <LibraryHostProvider value={host} key={host.key}><IntegrationsProvider>
    <HomeConnectorList host={host} home={home} assistantName={assistantName} panelNavigation={panelNavigation} />
  </IntegrationsProvider></LibraryHostProvider>;
});

export function CloudConnectorsSettings({ cloudDeviceId, assistantName }: { cloudDeviceId: string; assistantName: string }) {
  return <HomeConnectorsSettings home={{ kind: 'cloud', deviceId: cloudDeviceId }} assistantName={assistantName} />;
}

const HomeConnectorList = observer(function HomeConnectorList({ host, home, assistantName, panelNavigation }: Props & { host: LibraryHost }) {
  const { t, i18n } = useTranslation('assistant');
  const settings = useTranslation('settings').t;
  const { integrations, configuredConnections, connectionStatus, checkedConnections, connectionCheckError, hasConfiguredConnections, configuredConnectionsError, hasList, listError, reloadList } = useIntegrationsContext();
  const chats = useChatChannels();
  const stateFor = (id: string) => connectorState(hasConfiguredConnections ? !!configuredConnections[id] : undefined, checkedConnections[id], configuredConnectionsError ?? connectionCheckError, host.assistantPanelExpected);
  const [openId, setOpenId] = useState<string | null>(null);
  useAssistantPanelBack(panelNavigation && openId ? `connector:${openId}` : null, () => setOpenId(null));
  const reload = useCallback(() => void reloadList(), [reloadList]);
  const readError = useAssistantReadError(!hasList && !integrations.length, listError, host.key);
  const failure = useReadFailure(readError, host.remote?.deviceId ?? null, host.remote?.deviceLabel ?? '', reload);
  const apps = assistantConnectedApps(connectorOrder(integrations, i18n.language), chats.list, kind => settings(`channels.${kind}`), t('connectors.wechatDescription'), stateFor, configuredConnections);
  if (openId) {
    const app = apps.find(item => item.id === openId);
    return app ? <ConnectorDetail host={host} home={home} assistantName={assistantName} app={app} state={stateFor(openId)} account={connectionStatus[openId]?.displayName ?? null} panelNavigation={panelNavigation} onBack={() => setOpenId(null)} /> : null;
  }
  if (!hasList && !integrations.length) return <SettingsPage>
    <AppConnectionListPlaceholder />
    <SettingsNote tone={failure?.tone === 'danger' ? 'danger' : undefined}>{failure?.text}</SettingsNote>
    {failure?.retry ? <div><Button size="sm" onClick={failure.retry}>{t('machine.retry')}</Button></div> : null}
  </SettingsPage>;
  const isConnected = (app: AssistantConnectedApp) => app.state === 'connected';
  const isSaved = (app: AssistantConnectedApp) => app.saved;
  const groups = [
    { key: 'connected', title: t('connectors.connectedGroup'), items: apps.filter(isConnected) },
    { key: 'saved', title: t('connectors.savedGroup'), items: apps.filter(app => !isConnected(app) && isSaved(app)) },
    { key: 'available', title: t('connectors.availableGroup'), items: apps.filter(app => !isConnected(app) && !isSaved(app)) },
  ];
  return <SettingsPage data-testid="assistant-connectors-cloud">
    {failure ? <SettingsNote><span role="status">{failure.text}</span></SettingsNote> : null}
    <SettingsNote className="ta-connector-location-note">{accountNoteFor(home, assistantName, t)}</SettingsNote>
    {groups.filter(group => group.items.length).map(group => <SettingsGroup key={group.key} title={group.title} data-testid={`assistant-connectors-${group.key}`}>
      {group.items.map(app => <SettingsRow key={app.id} data-testid={`assistant-connector-${app.id}`} className="ta-application-row"
        leading={app.integration ? <IntegrationIcon provider={app.id} icon={app.integration.icon} size={32} /> : app.id === 'wechat' ? <ChannelBrandIcon kind="wechat" size={32} /> : undefined}
        title={app.name} description={app.description || <span aria-hidden="true">&nbsp;</span>}
        control={group.key === 'saved' ? <span className="gg-settings-row-value">{t(`connectors.${app.state}`)}</span> : <ChevronRight size={16} className="gg-settings-row-chevron" aria-hidden />}
        onClick={() => setOpenId(app.id)} />)}
    </SettingsGroup>)}
  </SettingsPage>;
});

const ConnectorDetail = observer(function ConnectorDetail({ host, home, assistantName, app, state, account, panelNavigation, onBack }: Props & {
  host: LibraryHost; app: AssistantConnectedApp; state: ConnectorState; account: string | null; onBack: () => void;
}) {
  const { t } = useTranslation('assistant');
  const detail = useAssistantPanelIntegration(host.assistantPanel, app.integration ?? null);
  const integration = detail.data;
  const { isCheckingConfiguredConnections, configuredConnections, disconnectIntegration, isIntegrationMutating } = useIntegrationsContext();
  const [disconnectError, setDisconnectError] = useState('');
  const showIntegrationSetup = useShowModal('integrationSetupModal');
  const showConnectGitHub = useShowModal('githubConnectModal');
  const showConfirm = useShowModal('confirmActionModal');
  const where = homeWhere(home, t);
  const configured = !!configuredConnections[app.id];
  return <SettingsPage data-testid="assistant-connector-detail">
    {!panelNavigation ? <div><Button variant="ghost" size="sm" onClick={onBack} data-testid="assistant-connector-back"><ChevronLeft size={16} aria-hidden />{t('connectors.title')}</Button></div> : null}
    <PageHead title={integration?.name ?? app.name} />
    {app.integration ? <>
      <AppConnectionHero icon={<IntegrationIcon provider={app.id} icon={(integration ?? app.integration).icon as never} size={56} />}
        description={(integration ?? app.integration).description} loading={detail.loading}
        label={t(state === 'connected' ? 'connectors.manage' : configured ? 'connectors.reconnect' : 'connectors.connect')}
        disabled={state === 'checking' || (isCheckingConfiguredConnections && !(app.id in configuredConnections))}
        onConnect={() => app.id === 'github' ? showConnectGitHub({ host }) : showIntegrationSetup({ integration: app.id, host })} />
      {detail.error && !integration ? <SettingsNote role="alert">{assistantPanelFailure(detail.error, t)}</SettingsNote> : null}
    </> : null}
    {configured ? <SettingsGroup title={t('connectors.connection', { name: integration?.name ?? app.name })}>
      <SettingsRow title={t('connectors.status')} control={<span className="gg-settings-row-value">{t(`connectors.${state}`)}</span>} />
      {account ? <SettingsRow title={t('connectors.account')} control={<span className="gg-settings-row-value">{account}</span>} /> : null}
      <Button size="sm" variant="danger" className="self-start" disabled={isIntegrationMutating?.(app.id)} data-testid="assistant-connector-disconnect" onClick={() => showConfirm({
        title: t('connectors.disconnectTitle', { name: app.name }),
        description: t('connectors.disconnectBody', { name: app.name, assistant: assistantName }),
        confirmLabel: t('connectors.disconnect'),
        onSuccess: () => {
          setDisconnectError('');
          void disconnectIntegration(app.id).then(result => { if (!result.success) setDisconnectError(assistantPanelFailure(result.error, t)); }, error => setDisconnectError(assistantPanelFailure(error, t)));
        },
      })}>{t('connectors.disconnect')}</Button>
      {disconnectError ? <SettingsNote role="alert" tone="danger">{disconnectError}</SettingsNote> : null}
    </SettingsGroup> : null}
    {app.id === 'wechat' ? <WechatAppConnection /> : null}
    {app.integration ? <SettingsGroup title={t('connectors.usableOn')}>
      {home.kind === 'cloud' ? <SettingsRow leading={<Cloud size={16} />} title={where} description={t('connectors.cloudWhereNote', { name: assistantName })} />
        : <SettingsRow leading={<Monitor size={16} />} title={where} description={t('connectors.accountWhereNote', { name: assistantName, device: where })} />}
    </SettingsGroup> : null}
  </SettingsPage>;
});
