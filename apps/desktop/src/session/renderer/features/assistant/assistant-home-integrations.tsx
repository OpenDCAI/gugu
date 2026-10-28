import { useQuery } from '@tanstack/react-query';
import { requireAssistantPanelBridge, useAssistantPanelAccountId } from '@/lib/assistantPanelBridge';
import { observer } from 'mobx-react-lite';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { IntegrationsProvider, useIntegrationsContext } from '@renderer/features/integrations/integrations-provider';
import { createRemoteLibraryHost, LibraryHostProvider, LOCAL_LIBRARY_HOST, useLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { AssistantContext } from './assistant-context';
import { connectorOrder } from './assistant-connector-order';
import { homeTarget } from './assistant-home-sessions';
import { useAssistantReadError, useReadFailure } from './assistant-read-failure';
import { retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead';
import { useAssistantShell } from './assistant-shell';
import { useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files';
import { assistantPanelLibraryHost } from '@/components/assistant/assistant-panel-library-host';
import { AssistantEmpty, AssistantRow, AssistantSection, MachineGate } from './assistant-ui';

/**
 * 「有账号的服务」(飞书、GitHub…)读写的那一份集成:存在它的家里(资源库「集成」同一份逻辑,机器钉死在它家那台),
 * 跟着它走,人换哪台设备登录都照样能用;住云上时人的电脑全关了也能用,住电脑时那台得开着。
 * 住电脑时就是那台电脑自己的集成(与那台「资源库 → 集成」同一份,统筹 10-16 定);搬家时账号随它走(剪切,只留一份)。
 * 这里是桌面会话页(引导的「连应用」一步)和全局设置「咕咕 → 连接应用」共用的一半;列表在设置里用设置的行画。
 */
export function useHomeLibraryHost(home: AssistantHomePlace): LibraryHost {
  const { t } = useTranslation('assistant');
  const local = homeTarget(home) === null;
  const deviceId = home.deviceId;
  const device = local ? null : remoteHostsStore.device(deviceId);
  // 云上那台的 label 是沙箱主机名(iZbp…),❌ 给人看:弹窗里说到它就叫「云端」。
  const label = home.kind === 'cloud' ? t('connectors.cloudWhere') : home.label ?? t('connectors.thisComputer');
  const online = device?.isOnline ?? false;
  const lastSeenAt = device?.lastSeenAt ?? null;
  const hostKind = device?.hostKind;
  const base = useMemo(
    () =>
      local
        ? LOCAL_LIBRARY_HOST
        : createRemoteLibraryHost({ deviceId, deviceLabel: label, online, lastSeenAt, hostKind }, (id, initialPath) =>
            remoteHostsStore.pickFolder(id, initialPath)
          ),
    [local, deviceId, label, online, lastSeenAt, hostKind]
  );
  const shell = useAssistantShell();
  const owner = useAssistantPanelAccountId();
  const identity = useQuery({ queryKey: ['assistant-panel-identity',owner],enabled: !!owner && !shell?.assistant?.id,
    queryFn: () => requireAssistantPanelBridge().personalAssistant(owner!),staleTime: Infinity,retry: retryAssistantPanelRead });
  const assistantId = shell?.assistant?.id ?? identity.data ?? null;
  const folder = useQuery({
    queryKey: ['assistant-panel-folder',owner,assistantId],enabled: !!owner && !!assistantId && !shell?.chatId,
    queryFn: async () => {
      return requireAssistantPanelBridge().privateChat(owner!,assistantId!);
    },staleTime: Infinity,retry: retryAssistantPanelRead,
  });
  const machine = useCloudAssistantFiles(assistantId,shell?.chatId ?? folder.data ?? null,home.deviceId);
  const prepare = useCallback(async () => {
    if (local) return;
    remoteHostsStore.start();
    if (home.kind === 'cloud' && !await remoteHostsStore.wakeCloudComputer(deviceId)) {
      const failure = remoteHostsStore.wakeFailure(deviceId);
      const key = failure?.code === 'credits_exhausted' ? 'authorizationCreditsExhausted'
        : failure?.code === 'membership_expired' ? 'authorizationMembershipExpired'
          : failure?.reason === 'timeout' ? 'authorizationTimedOut' : 'authorizationUnavailable';
      throw new Error(t(`connectors.${key}`));
    }
    remoteHostsStore.reconnect(deviceId);
    // The following control read owns readiness and preserves a protocol refusal.
    // Waiting only for `connected` here hides an already known `outdated` state.
  },[local,home.kind,deviceId,t]);
  return useMemo(() => assistantPanelLibraryHost(base,machine?.panel,prepare,folder.error ?? identity.error),[base,machine,prepare,folder.error,identity.error]);
}

/** 点一家直接弹它的连接框(引导里那一步:不往下钻详情页)。要在 HomeIntegrations 里头用。 */
export function useOpenConnector(home: AssistantHomePlace): (id: string) => void {
  const showIntegrationSetup = useShowModal('integrationSetupModal');
  const showConnectGitHub = useShowModal('githubConnectModal');
  const host = useHomeLibraryHost(home);
  return (id) => (id === 'github' ? showConnectGitHub({ host }) : showIntegrationSetup({ integration: id, host }));
}

/** 它家那台叫什么(「这台电脑」/ 那台的名字;云上 =「云端」)。 */
export function homeWhere(home: AssistantHomePlace, t: (key: string) => string): string {
  if (home.kind === 'cloud') return t('connectors.cloudWhere');
  return homeTarget(home) === null ? t('connectors.thisComputer') : home.label ?? t('connectors.thisComputer');
}

/** 「账号」那一段的一句话:按它实际住哪说(❌ 住在电脑上还说「存在云上」)。 */
export function accountNoteFor(home: AssistantHomePlace, name: string, t: (key: string, values?: Record<string, string>) => string): string {
  if (home.kind === 'cloud') return t('connectors.cloudNote', { name });
  if (homeTarget(home) === null) return t('connectors.accountNoteHere', { name, device: home.label ?? t('connectors.thisComputer') });
  return t('connectors.accountNoteThere', { name, device: home.label ?? t('connectors.thisComputer') });
}

export function accountNote(context: AssistantContext, t: (key: string, values?: Record<string, string>) => string): string {
  return accountNoteFor(context.home, context.assistant.display_name, t);
}

/** 它家那台的集成(资源库「集成」同一套 provider)。机器还没读到时由 MachineGate 说明白。 */
export const HomeIntegrations = observer(function HomeIntegrations({ context, children }: { context: AssistantContext; children: ReactNode }) {
  const host = useHomeLibraryHost(context.home);
  return (
    <MachineGate readiness={context.readiness} loading={context.machineLoading} error={context.machineError} onRetry={context.retryMachine}>
      <LibraryHostProvider value={host} key={host.key}>
        <IntegrationsProvider>{children}</IntegrationsProvider>
      </LibraryHostProvider>
    </MachineGate>
  );
});

/** 已连接 / 可用 两组;点一行做什么由调用方定(引导里直接弹连接框)。 */
export const ConnectorLists = observer(function ConnectorLists({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation('assistant');
  const { integrations, configuredConnections, connectionStatus, hasList, listError, reloadList } = useIntegrationsContext();
  const { remote } = useLibraryHost();
  const reload = useCallback(() => void reloadList(), [reloadList]);
  const readError = useAssistantReadError(!hasList,listError,remote?.deviceId ?? '');
  const failure = useReadFailure(hasList ? null : readError, remote?.deviceId ?? null, remote?.deviceLabel ?? '', reload);
  if (failure)
    return (
      <AssistantEmpty action={failure.retry ? <button type="button" className="ta-pill-btn" onClick={failure.retry}>{t('machine.retry')}</button> : undefined}>
        <span role={failure.tone === 'danger' ? 'alert' : 'status'} data-testid="assistant-connectors-read-failed">{failure.text}</span>
      </AssistantEmpty>
    );
  const ordered = connectorOrder(integrations, i18n.language);
  const connected = ordered.filter((i) => configuredConnections[i.id]);
  const available = ordered.filter((i) => !configuredConnections[i.id]);
  const row = (integration: (typeof integrations)[number], detail: string | undefined) => (
    <AssistantRow
      key={integration.id}
      testId={`assistant-connector-${integration.id}`}
      leading={<IntegrationIcon provider={integration.id} icon={integration.icon} size={30} />}
      title={integration.name}
      detail={detail || '\u00a0'}
      detailLines={1}
      onClick={() => onOpen(integration.id)}
    />
  );
  return (
    <>
      {connected.length ? (
        <AssistantSection title={t('connectors.connectedGroup')} testId="assistant-connectors-connected">
          {connected.map((i) => row(i, connectionStatus[i.id]?.displayName ?? i.description))}
        </AssistantSection>
      ) : null}
      <AssistantSection title={t('connectors.availableGroup')} testId="assistant-connectors-available">
        {available.map((i) => row(i, i.description))}
      </AssistantSection>
    </>
  );
});
