import { useAssistantPanelIntegration } from '@/components/assistant/useAssistantPanelIntegration';
import { assistantPanelFailure } from '@/components/assistant/assistant-panel-errors';
import type { IntegrationMetadata } from '@renderer/features/integrations/integrations-provider';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
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

/**
 * 全局设置「咕咕 → 连接应用」里「云端」那一段(owner 10-16:只有一个设置,咕咕的设置是它的一组):
 * 数据与助理 App 里「资料 → 连接应用」同一份(资源库「集成」的同一套 provider,机器钉死在它住的那台),
 * 这里只是用设置的行去画;点一行进详情(同页内,左上「连接应用」回来)。
 * 壳的设置弹窗经 SessionSettingsContent 渲染它(同一份模块实例、同一个 modalStore / queryClient)。
 */
export const HomeConnectorsSettings = observer(function HomeConnectorsSettings({ home, assistantName }: { home: AssistantHomePlace; assistantName: string }) {
  const host = useHomeLibraryHost(home);
  return (
    <LibraryHostProvider value={host} key={host.key}>
      <IntegrationsProvider>
        <HomeConnectorList host={host} home={home} assistantName={assistantName} />
      </IntegrationsProvider>
    </LibraryHostProvider>
  );
});

/** 住云上(会员):机器钉死在云端那台。老入口,只给云上的家。 */
export function CloudConnectorsSettings({ cloudDeviceId, assistantName }: { cloudDeviceId: string; assistantName: string }) {
  return <HomeConnectorsSettings home={{ kind: 'cloud', deviceId: cloudDeviceId }} assistantName={assistantName} />;
}

const HomeConnectorList = observer(function HomeConnectorList({ host, home, assistantName }: { host: LibraryHost; home: AssistantHomePlace; assistantName: string }) {
  const { t, i18n } = useTranslation('assistant');
  const { integrations, configuredConnections, connectionStatus, checkedConnections, connectionCheckError, hasConfiguredConnections, configuredConnectionsError, hasList, listError, reloadList } = useIntegrationsContext();
  const showIntegrationSetup = useShowModal('integrationSetupModal');
  const showConnectGitHub = useShowModal('githubConnectModal');
  const connect = (id: string) => id === 'github' ? showConnectGitHub({ host }) : showIntegrationSetup({ integration: id, host });
  const stateFor = (id: string) => connectorState(hasConfiguredConnections ? !!configuredConnections[id] : undefined, checkedConnections[id], configuredConnectionsError ?? connectionCheckError,host.assistantPanelExpected);
  const [openId, setOpenId] = useState<string | null>(null);
  const reload = useCallback(() => void reloadList(), [reloadList]);
  const readError = useAssistantReadError(!hasList && !integrations.length,listError,host.key);
  const failure = useReadFailure(readError, host.remote?.deviceId ?? null, host.remote?.deviceLabel ?? '', reload);
  if (failure && !integrations.length)
    return (
      <SettingsPage>
        <SettingsNote tone={failure.tone === 'danger' ? 'danger' : undefined}>{failure.text}</SettingsNote>
        {failure.retry ? (
          <div>
            <Button size="sm" onClick={failure.retry}>{t('machine.retry')}</Button>
          </div>
        ) : null}
      </SettingsPage>
    );
  if (!hasList && !integrations.length) return <SettingsNote>{t('connectors.checking')}</SettingsNote>;
  if (openId) {
    const integration = integrations.find((i) => i.id === openId) ?? null;
    return (
      <ConnectorDetail
        host={host}
        home={home}
        assistantName={assistantName}
        integration={integration}
        state={stateFor(openId)}
        account={connectionStatus[openId]?.displayName ?? null}
        onBack={() => setOpenId(null)}
      />
    );
  }
  const ordered = connectorOrder(integrations, i18n.language);
  const connected = ordered.filter((i) => configuredConnections[i.id]);
  const available = ordered.filter((i) => !configuredConnections[i.id]);
  const row = (integration: (typeof integrations)[number], detail: string | undefined) => {
    const state = stateFor(integration.id);
    return (
      <div className="ta-connector-row" key={integration.id}>
        <SettingsRow
          data-testid={`assistant-connector-${integration.id}`}
          leading={<IntegrationIcon provider={integration.id} icon={integration.icon} size={28} />}
          title={integration.name}
          description={detail}
          control={
            <span className="flex items-center gap-2">
              <Chip tone={state === 'connected' ? 'ok' : state === 'needsReauth' || state === 'checkFailed' ? 'warn' : 'default'}>{t(`connectors.${state}`)}</Chip>
              <ChevronRight size={16} className="gg-settings-row-chevron" aria-hidden="true" />
            </span>
          }
          onClick={() => setOpenId(integration.id)}
        />
        {state === 'notConnected' || state === 'needsReauth' ? (
          <Button size="sm" variant="ghost" className="ta-pill-btn" onClick={() => connect(integration.id)} data-testid={`assistant-connect-${integration.id}`}>
            {t(state === 'needsReauth' ? 'connectors.reconnect' : 'connectors.connect')}
          </Button>
        ) : null}
      </div>
    );
  };
  return (
    <SettingsPage data-testid="assistant-connectors-cloud">
      {failure ? <SettingsNote><span role="status">{failure.text}</span></SettingsNote> : null}
      <SettingsNote className="ta-connector-location-note">{accountNoteFor(home, assistantName, t)}</SettingsNote>
      {connected.length ? (
        <SettingsGroup title={t('connectors.savedGroup')} data-testid="assistant-connectors-connected">
          {connected.map((i) => row(i, connectionStatus[i.id]?.displayName ?? i.description))}
        </SettingsGroup>
      ) : null}
      <SettingsGroup title={t('connectors.availableGroup')} data-testid="assistant-connectors-available">
        {available.map((i) => row(i, i.description))}
      </SettingsGroup>
    </SettingsPage>
  );
});

const ConnectorDetail = observer(function ConnectorDetail({
  host,
  home,
  assistantName,
  integration: summary,
  state,
  account,
  onBack,
}: {
  host: LibraryHost;
  home: AssistantHomePlace;
  assistantName: string;
  integration: IntegrationMetadata | null;
  state: ConnectorState;
  account: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation('assistant');
  const detail = useAssistantPanelIntegration(host.assistantPanel,summary);
  const integration = detail.data;
  const { isCheckingConfiguredConnections, configuredConnections } = useIntegrationsContext();
  const showIntegrationSetup = useShowModal('integrationSetupModal');
  const showConnectGitHub = useShowModal('githubConnectModal');
  const where = homeWhere(home, t);
  const connected = state === 'connected';
  const back = (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack} data-testid="assistant-connector-back">
        <ChevronLeft size={16} aria-hidden="true" />
        {t('connectors.title')}
      </Button>
    </div>
  );
  if (detail.error || detail.loading) return <SettingsPage>{back}<SettingsNote>{detail.error ? assistantPanelFailure(detail.error,t) : t('library.loading')}</SettingsNote></SettingsPage>;
  if (!integration)
    return (
      <SettingsPage>
        {back}
        <SettingsNote>{home.kind === 'cloud' ? t('connectors.gone') : t('connectors.goneHome', { device: where })}</SettingsNote>
      </SettingsPage>
    );
  return (
    <SettingsPage data-testid="assistant-connector-detail">
      {back}
      <SettingsGroup>
        <div className="ta-connector-hero">
          <IntegrationIcon provider={integration.id} icon={integration.icon as never} size={64} />
          <h2>{integration.name}</h2>
          {integration.description ? <p>{integration.description}</p> : null}
            <Button
              variant={connected ? 'secondary' : 'primary'}
              size="sm"
              disabled={state === 'checking' || (isCheckingConfiguredConnections && !(integration.id in configuredConnections))}
              onClick={() => integration.id === 'github' ? showConnectGitHub({ host }) : showIntegrationSetup({ integration: integration.id, host })}
              data-testid="assistant-connector-connect"
            >
              {t(connected ? 'connectors.manage' : state === 'notConnected' ? 'connectors.connect' : 'connectors.reconnect')}
            </Button>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('connectors.connection', { name: integration.name })}>
        <SettingsRow
          title={t('connectors.status')}
          control={<span className="gg-settings-row-value">{t(`connectors.${state}`)}</span>}
        />
        {account ? <SettingsRow title={t('connectors.account')} control={<span className="gg-settings-row-value">{account}</span>} /> : null}
      </SettingsGroup>
      <SettingsGroup title={t('connectors.usableOn')}>
        {home.kind === 'cloud' ? (
          <SettingsRow leading={<Cloud size={16} />} title={where} description={t('connectors.cloudWhereNote', { name: assistantName })} />
        ) : (
          <SettingsRow leading={<Monitor size={16} />} title={where} description={t('connectors.accountWhereNote', { name: assistantName, device: where })} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
});
