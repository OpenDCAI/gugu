import React, { useMemo, useState } from 'react';
import { integrationErrorText } from '@renderer/features/integrations/integration-display';
import { useIntegrationsContext } from '@renderer/features/integrations/integrations-provider';
import { PageLoading } from '@renderer/lib/components/page-layout';
import type { IntegrationAccountSummary } from '@renderer/features/integrations/use-integration-accounts';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { sortGitHubAccountsByDefault } from '@renderer/features/projects/components/github-account-select-model';
import { useGitHubAccounts } from '@renderer/lib/hooks/useGithubAccounts';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import type { ConnectionStatus } from '@shared/issue-providers';
import { IntegrationDetailSidebar } from './IntegrationDetailSidebar';
import { IntegrationGridCard } from './IntegrationGridCard';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

export type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  icon: AgentIconAsset;
  features: string[];
  isConfigured: boolean;
  isConfigurationKnown: boolean;
  isMutating: boolean;
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):照旧看得到,连 / 断都灰着。 */
  readOnly?: boolean;
  /** 按界面语言说的那句;那一家的原话在 `connectionErrorDetail`(悬停)。 */
  connectionError?: string;
  connectionErrorDetail?: string;
  displayName?: string;
  displayDetail?: string;
  onConnect: () => void;
  onDisconnect?: () => void | Promise<void>;
  /** #7240 详情「能力」「推荐玩法」(主进程按界面语言给好的字符串)。 */
  abilities: string[];
  playbooks: { title: string; prompt: string }[];
  /** 一家能连几个账号(邮箱):详情逐个列账号、「添加另一个账号」。 */
  multiAccount: boolean;
  /** 填表连的那几家:「编辑凭据」(预填不保密的那几项,授权码留空沿用)。 */
  onEditAccount?: (account: IntegrationAccountSummary) => void;
  /** 多账号里断开一个(「只会断开 %s」)。 */
  onDisconnectAccount?: (accountId: string, label: string) => void;
  /** 「试试看」:开一个新任务,输入框里填好这句话。只在本机。 */
  onTryPlaybook?: (prompt: string) => void;
};

const IntegrationsCard: React.FC = () => {
  const {
    connectionStatus,
    configuredConnections,
    isCheckingConfiguredConnections,
    disconnectIntegration,
    integrations: integrationMetadata,
    isIntegrationMutating,
    listError,
    hasList,
    reloadList,
  } = useIntegrationsContext();
  // #6264 资源库看的是别的机器:连 / 断的是那台机器上的集成;弹窗带上它(弹窗挂在应用根上,自己拿不到)。
  const host = useLibraryHost();
  const modalHost = host.remote ? host : undefined;
  const { data: githubAccounts = [] } = useGitHubAccounts();
  const sortedGithubAccounts = useMemo(
    () => sortGitHubAccountsByDefault(githubAccounts),
    [githubAccounts]
  );
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const showIntegrationSetup = useShowModal('integrationSetupModal');
  const showConnectGitHub = useShowModal('githubConnectModal');
  const showConfirm = useShowModal('confirmActionModal');
  const { translate } = useSessionMessages();
  const notice = deviceScopeNotice(
    { remote: host.remote, error: listError, hasData: hasList, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );

  const { navigate } = useNavigate();

  // #7240 断开确认的话:「要断开与 %s 的连接吗?」「agent 将无法再访问你的 %s 数据。」;
  // 存着凭据的(填表连的)再补一句「只删咕咕存的,要让授权码失效去对方那边撤」。
  const confirmDisconnect = ({
    name,
    credential,
    onDisconnect,
  }: {
    name: string;
    credential?: string;
    onDisconnect: () => void | Promise<void>;
  }) => {
    const loseAccess = translate('integrations.disconnectLoseAccess', { name });
    showConfirm({
      // @@@raw provider name — integration 名与凭据类型名是 provider 数据,只做插值。
      title: translate('integrations.disconnectConfirmTitle', { name }),
      description: credential ? `${loseAccess}${translate('integrations.credentialsDeleteNotice')}` : loseAccess,
      confirmLabel: translate('integrations.disconnect'),
      onSuccess: () => {
        void onDisconnect();
      },
    });
  };

  const confirmDisconnectAccount = (provider: string, accountId: string, label: string, hasCredential: boolean) => {
    const only = translate('integrations.disconnectAccountDescription', { account: label });
    showConfirm({
      title: translate('integrations.disconnectAccountTitle'),
      // @@@raw account label — 账号名是用户数据(邮箱地址),只做插值。
      description: hasCredential ? `${only}${translate('integrations.credentialsDeleteNotice')}` : only,
      confirmLabel: translate('integrations.disconnect'),
      onSuccess: () => {
        void disconnectIntegration(provider, accountId);
      },
    });
  };

  // 「试试看」:与扩展的「对 agent 说」同一条路 —— 新建任务那一页读这一格草稿。
  // 连在别的机器(助理的云电脑)上的,任务也开在那台:连接只在那台的会话里有,开在本机 agent 用不上。
  const tryPlaybook = (prompt: string) => {
    composerDrafts.set(NEW_SESSION_DRAFT_KEY, prompt);
    if (host.remote) remoteHostsStore.requestNewSession(host.remote.deviceId, null);
    navigate('new-session');
  };

  // 注册表里的每一家都列出来(#7210):飞书、腾讯文档这类只给 agent 用的服务不是 issue 系统,
  // ❌ 再按「是不是 issue 系统」筛 —— 那样它们连卡片都没有。
  const integrations: IntegrationItem[] = integrationMetadata.map((integration) => {
    const provider = integration.id;
    const status: ConnectionStatus = connectionStatus[provider] ?? {
      connected: false,
      capabilities: integration.capabilities,
    };
    const isConfigured = configuredConnections[provider] ?? false;
    const hasForm = integration.auth.methods.some((method) => method.kind === 'form');
    const isConfigurationKnown =
      provider in configuredConnections || !isCheckingConfiguredConnections;

    if (provider === 'github') {
      return {
        id: provider,
        name: integration.name,
        description: integration.description,
        icon: integration.icon,
        features: integration.features,
        isConfigured,
        isConfigurationKnown,
        isMutating: false,
        readOnly: !!notice?.readOnly,
        connectionError: isConfigured ? integrationErrorText(translate, integration.name, status) : undefined,
        connectionErrorDetail: isConfigured ? status.error : undefined,
        displayName: sortedGithubAccounts[0]?.login ?? status.displayName,
        displayDetail: status.displayDetail,
        onConnect: () => showConnectGitHub({ host: modalHost }),
        abilities: integration.abilities ?? [],
        playbooks: integration.playbooks ?? [],
        multiAccount: false,
        onTryPlaybook: tryPlaybook,
      };
    }

    return {
      id: provider,
      name: integration.name,
      description: integration.description,
      icon: integration.icon,
      features: integration.features,
      isConfigured,
      isConfigurationKnown,
      isMutating: isIntegrationMutating(provider),
      readOnly: !!notice?.readOnly,
      connectionError: isConfigured ? integrationErrorText(translate, integration.name, status) : undefined,
      connectionErrorDetail: isConfigured ? status.error : undefined,
      displayName: status.displayName,
      displayDetail: status.displayDetail,
      abilities: integration.abilities ?? [],
      playbooks: integration.playbooks ?? [],
      multiAccount: integration.multiAccount ?? false,
      onTryPlaybook: tryPlaybook,
      ...(hasForm && !notice?.readOnly
        ? {
            onEditAccount: (account: IntegrationAccountSummary) =>
              showIntegrationSetup({
                integration: provider,
                host: modalHost,
                editAccount: { accountId: account.accountId, fields: account.fields },
              }),
          }
        : {}),
      ...(notice?.readOnly
        ? {}
        : {
            onDisconnectAccount: (accountId: string, label: string) =>
              confirmDisconnectAccount(provider, accountId, label, hasForm),
          }),
      onConnect: () => showIntegrationSetup({ integration: provider, host: modalHost }),
      onDisconnect: notice?.readOnly
        ? undefined
        : () =>
            confirmDisconnect({
              name: integration.name,
              credential: integration.disconnectCredentialLabel,
              onDisconnect: () => {
                void disconnectIntegration(provider);
              },
            }),
    };
  });

  const connectedIntegrations = integrations.filter((integration) => integration.isConfigured);
  const availableIntegrations = integrations.filter(
    (integration) => integration.isConfigurationKnown && !integration.isConfigured
  );
  const selectedIntegration = selectedProvider
    ? (integrations.find((integration) => integration.id === selectedProvider) ?? null)
    : null;

  function closeSheet() {
    setSelectedProvider(null);
  }

  // 别的机器此刻给不出清单(离线且没读过 / server 太旧 / 问不通):只说那一句,❌ 画一排「可连接」冒充它上面什么都没连。
  if (notice && !hasList) return <DeviceScopeNoticeLine notice={notice} onRetry={reloadList} />;
  // 清单还在读:画加载态(读到了才知道哪些连着)。
  if (!hasList && !listError) return <PageLoading />;

  return (
    <TooltipProvider delay={150}>
      {notice && <DeviceScopeNoticeLine notice={notice} onRetry={reloadList} />}
      <div className="space-y-8">
        {connectedIntegrations.length > 0 && (
          <IntegrationSection title={translate('integrations.sectionAdded')}>
            {connectedIntegrations.map((integration) => (
              <IntegrationGridCard
                key={integration.id}
                integration={integration}
                selected={integration.id === selectedProvider}
                onSelect={() => setSelectedProvider(integration.id)}
              />
            ))}
          </IntegrationSection>
        )}

        <IntegrationSection title={translate('integrations.sectionAvailable')}>
          {availableIntegrations.map((integration) => (
            <IntegrationGridCard
              key={integration.id}
              integration={integration}
              selected={integration.id === selectedProvider}
              onSelect={() => setSelectedProvider(integration.id)}
            />
          ))}
        </IntegrationSection>
      </div>

      <Sheet open={selectedIntegration !== null} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent showCloseButton={false}>
          {selectedIntegration && (
            <IntegrationDetailSidebar
              integration={selectedIntegration}
              githubAccounts={sortedGithubAccounts}
              onClose={closeSheet}
            />
          )}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
};

function IntegrationSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-normal text-foreground">{title}</h3>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
      >
        {children}
      </div>
    </section>
  );
}

export default IntegrationsCard;
