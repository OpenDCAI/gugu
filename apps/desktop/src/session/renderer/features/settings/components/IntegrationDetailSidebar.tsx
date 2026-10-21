import { Pencil, Plus, Sparkles, Trash2, X } from '@/lib/icons'
import { useQueries } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { issueFeatureLabels } from '@renderer/features/integrations/integration-display';
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon';
import { ISSUE_CONNECTION_STATUS_QUERY_KEY } from '@renderer/features/integrations/integrations-provider';
import {
  useIntegrationAccounts,
  type IntegrationAccountSummary,
} from '@renderer/features/integrations/use-integration-accounts';
import {
  LOCAL_LIBRARY_HOST,
  machineLibraryHost,
  useLibraryHost,
  type LibraryHost,
} from '@renderer/features/library/library-host';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { Button } from '@renderer/lib/ui/button';
import { SHEET_SAFE_INSET_RIGHT } from '@renderer/lib/ui/sheet';
import { MicroLabel } from '@renderer/lib/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { GitHubAccountSummary } from '@shared/github';
import { GitHubAccountRows } from './GitHubAccountsSection';
import type { IntegrationItem } from './IntegrationsCard';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

/**
 * 资源库里一家集成的详情(`connectors.*`,#7240):
 * 「%s 连接」(状态 / 连接时间 / 账号;多账号逐个列、逐个断、「添加另一个账号」)→「能力」→
 * 「%s 可用于以下设备」→「推荐玩法」(「试试看」开一个填好这句话的新任务)。
 */
export function IntegrationDetailSidebar({
  integration,
  githubAccounts,
  onClose,
}: {
  integration: IntegrationItem;
  githubAccounts: GitHubAccountSummary[];
  onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const featureLabels = issueFeatureLabels(translate);

  return (
    <div className="relative flex h-full flex-col">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="absolute top-4 p-0"
        // 这颗 ✕ 是 `absolute` 钉在抽屉右上角的,不在 header 行里 ⇒ 让开窗口控制条要写 `right`
        // 而不是 padding;读的仍是同一个数(见 sheet.tsx 的 @@@sheet-window-controls-lane)。
        style={{ right: SHEET_SAFE_INSET_RIGHT }}
        aria-label={translate('common.close')}
      >
        <X className="size-4" />
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4">
        <div className="space-y-6">
          <div>
            <MicroLabel>{translate('integrations.sectionIntegration')}</MicroLabel>
            <div className="mt-3 flex items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center">
                <IntegrationIcon provider={integration.id} icon={integration.icon} size={36} />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-sm font-medium text-foreground">{integration.name}</h2>
                  <div className="flex flex-wrap items-center gap-1">
                    {integration.features.map((feature) => (
                      <CapabilityBadge key={feature}>
                        {/* @@@raw feature id — 未登记的能力 id 原样显示。 */}
                        {featureLabels[feature] ?? feature}
                      </CapabilityBadge>
                    ))}
                  </div>
                </div>
                <p className="text-sm leading-5 text-foreground-muted">{integration.description}</p>
              </div>
            </div>
          </div>

          <section>
            <MicroLabel>{translate('integrations.connectionSection', { name: integration.name })}</MicroLabel>
            <div className="mt-3">
              {integration.id === 'github' ? (
                <div className="space-y-2">
                  {githubAccounts.length > 0 && (
                    <GitHubAccountRows accounts={githubAccounts} readOnly={integration.readOnly} />
                  )}
                  <AddAccountCard
                    integration={integration}
                    label={translate('github.add')}
                    detail={
                      githubAccounts.length === 0
                        ? translate('github.none')
                        : translate('github.connectHint')
                    }
                  />
                </div>
              ) : !integration.isConfigured ? (
                <AddAccountCard integration={integration} />
              ) : integration.multiAccount ? (
                <MultiAccountConnection integration={integration} />
              ) : (
                <SingleAccountConnection integration={integration} />
              )}
            </div>
          </section>

          {integration.abilities.length > 0 && (
            <section>
              <MicroLabel>{translate('integrations.abilitiesLabel')}</MicroLabel>
              <ul className="mt-3 space-y-2">
                {integration.abilities.map((ability) => (
                  <li key={ability} className="flex gap-2 text-sm text-foreground">
                    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-foreground-muted" />
                    {/* @@@raw ability copy — 插件元数据,主进程已按界面语言挑好。 */}
                    <span>{ability}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <DeviceAvailability integration={integration} />

          {integration.playbooks.length > 0 && (
            <section>
              <MicroLabel>{translate('integrations.playbooksLabel')}</MicroLabel>
              <div className="mt-3 space-y-2">
                {integration.playbooks.map((playbook) => (
                  <div key={playbook.title} className="flex items-start gap-3 rounded-lg bg-background-2 p-3">
                    <Sparkles className="h-4 w-4 shrink-0 text-foreground-muted" />
                    <div className="min-w-0 flex-1">
                      {/* @@@raw playbook copy — 插件元数据,主进程已按界面语言挑好。 */}
                      <p className="text-sm font-medium text-foreground">{playbook.title}</p>
                      <p className="mt-1 text-xs leading-5 text-foreground-muted">{playbook.prompt}</p>
                    </div>
                    {integration.onTryPlaybook && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        // 没连上时点它 = 先去连:❌ 把一句 agent 用不上工具的话塞进新任务。
                        onClick={() =>
                          integration.isConfigured ? integration.onTryPlaybook?.(playbook.prompt) : integration.onConnect()
                        }
                      >
                        {translate('integrations.tryOut')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function CapabilityBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-sm bg-background-2 px-1.5 text-xs font-medium text-foreground-muted">
      {children}
    </span>
  );
}

function formatDay(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 px-3 py-2">
      <span className="shrink-0 text-sm text-foreground-muted">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2 text-sm text-foreground">{children}</div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${ok ? 'bg-foreground-success' : 'bg-foreground-destructive'}`} />;
}

/** 一个账号的那一家(状态 / 连接时间 / 账号三行);连接时间读得到才列。 */
function SingleAccountConnection({ integration }: { integration: IntegrationItem }) {
  const { translate } = useSessionMessages();
  const { accounts } = useIntegrationAccounts(integration.id, integration.isConfigured);
  const account = accounts[0];
  // 凭据还存着、检查却不通过(令牌被撤 / 过期):说检查的原话(悬停),给「重新连接」(同一个连接弹窗)。
  const failed = integration.connectionError;
  return (
    <div className="space-y-2">
      <div className="divide-y divide-border rounded-lg bg-background-2" data-testid="integration-connection-rows">
        <InfoRow label={translate('integrations.statusLabel')}>
          <StatusDot ok={!failed} />
          <span
            className={failed ? 'truncate text-foreground-warning' : 'truncate'}
            title={failed ? integration.connectionErrorDetail : undefined}
            data-testid="integration-account-status"
          >
            {failed ? translate('integrations.needsReauthorization') : translate('integrations.statusConnected')}
          </span>
          {failed && !integration.readOnly && (
            <Button type="button" variant="outline" size="sm" onClick={integration.onConnect} disabled={integration.isMutating}>
              {translate('integrations.reconnect')}
            </Button>
          )}
        </InfoRow>
        {account && (
          <InfoRow label={translate('integrations.connectedAtLabel')}>{formatDay(account.connectedAt)}</InfoRow>
        )}
        <InfoRow label={translate('integrations.accountRowLabel')}>
          <span className="truncate">
            {integration.displayName ??
              account?.displayName ??
              translate('integrations.accountFallbackName', { name: integration.name })}
          </span>
        </InfoRow>
      </div>
      {failed && <p className="px-1 text-xs text-foreground-muted">{failed}</p>}
      {!integration.readOnly && (
        <div className="flex justify-end gap-2">
          {integration.onEditAccount && account && (
            <Button type="button" variant="ghost" size="sm" onClick={() => integration.onEditAccount?.(account)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              {translate('integrations.editCredentials')}
            </Button>
          )}
          {integration.onDisconnect && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground-destructive"
              onClick={integration.onDisconnect}
              aria-label={translate('integrations.disconnectLabel', { name: integration.name })}
            >
              {translate('integrations.disconnect')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** 一家连了几个账号(邮箱):逐个列、逐个查、逐个断,底下「添加另一个账号」(多账号那一组)。 */
function MultiAccountConnection({ integration }: { integration: IntegrationItem }) {
  const { translate } = useSessionMessages();
  const { supported, accounts, checks, isChecking, isLoading, error, retry } = useIntegrationAccounts(
    integration.id,
    integration.isConfigured
  );
  if (isLoading) return <LoadingIndicator size="inline" className="text-foreground-muted" />;
  // 读不到账号:说出来、给重试。❌ 落回单账号的样子 —— 那里的「断开连接」会一次删掉所有邮箱。
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-background-2 p-3">
        <p className="min-w-0 text-xs text-foreground-warning" role="alert">
          {/* @@@raw detail — 读账号失败的原话。 */}
          {error instanceof Error ? error.message : String(error)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          {translate('integrations.cliRetry')}
        </Button>
      </div>
    );
  }
  // 那台机器比多账号老(只有这一种才回落):照旧按一个账号画。
  if (!supported) return <SingleAccountConnection integration={integration} />;
  return (
    <div className="space-y-2">
      {accounts.map((account) => (
        <AccountRow
          key={account.accountId}
          integration={integration}
          account={account}
          check={checks.get(account.accountId)}
          checking={isChecking}
        />
      ))}
      {!integration.readOnly && (
        <AddAccountCard integration={integration} label={translate('integrations.addAnotherAccount')} detail="" />
      )}
    </div>
  );
}

function accountLabel(integration: IntegrationItem, account: IntegrationAccountSummary): string {
  return account.displayName ?? account.fields.email ?? integration.name;
}

function AccountRow({
  integration,
  account,
  check,
  checking,
}: {
  integration: IntegrationItem;
  account: IntegrationAccountSummary;
  check: { connected: boolean; error?: string } | undefined;
  checking: boolean;
}) {
  const { translate } = useSessionMessages();
  const label = accountLabel(integration, account);
  const failed = check && !check.connected;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-background-2 p-3" data-testid="integration-account-row">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        <IntegrationIcon provider={integration.id} icon={integration.icon} size={22} />
      </div>
      <div className="min-w-0 flex-1">
        {/* @@@raw account label — 账号名是用户数据(邮箱地址)。 */}
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p
          className={failed ? 'truncate text-xs text-foreground-warning' : 'truncate text-xs text-foreground-muted'}
          title={failed ? check?.error : undefined}
        >
          {failed
            ? translate('integrations.needsReauthorization')
            : !check && checking
              ? translate('integrations.checkingAccount')
              : translate('integrations.connectedOn', { date: formatDay(account.connectedAt) })}
        </p>
      </div>
      {!integration.readOnly && integration.onEditAccount && (
        <Tooltip>
          <TooltipTrigger render={
            <Button
              type="button"
              variant={failed ? 'outline' : 'ghost'}
              size={failed ? 'sm' : 'icon-sm'}
              onClick={() => integration.onEditAccount?.(account)}
              aria-label={translate('integrations.editCredentials')}
            >
              {failed ? translate('integrations.reconnect') : <Pencil className="h-3.5 w-3.5" />}
            </Button>
          } />
          <TooltipContent side="top">{translate('integrations.editCredentials')}</TooltipContent>
        </Tooltip>
      )}
      {!integration.readOnly && integration.onDisconnectAccount && (
        <Tooltip>
          <TooltipTrigger render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => integration.onDisconnectAccount?.(account.accountId, label)}
              aria-label={translate('integrations.disconnectLabel', { name: label })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          } />
          <TooltipContent side="top">{translate('integrations.disconnect')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * 「%s 可用于以下设备」(`connectors.available`):咕咕里集成是分机器连的(#6264),连在哪台、那台的 agent 能用。
 * 本机在前,然后名下别的机器;在线的问它连没连(同一份缓存,资源库切到那台时直接用上),离线的写离线。
 */
const DeviceAvailability = observer(function DeviceAvailability({ integration }: { integration: IntegrationItem }) {
  const { translate } = useSessionMessages();
  const current = useLibraryHost();
  useEffect(() => remoteHostsStore.start(), []);
  const machines: { key: string; label: string; online: boolean; host: LibraryHost }[] = [
    { key: LOCAL_LIBRARY_HOST.key, label: translate('task.deviceLocal'), online: true, host: LOCAL_LIBRARY_HOST },
    // #7199 个人助理住的那台不列(用户看不到它住在哪;它用的账号服务在「助理」App 的「连接应用 · 云端」)。
    ...[...remoteHostsStore.hosts.values()].filter(({ device }) => !device.assistantHome).map(({ device }) => {
      const host = machineLibraryHost({
        deviceId: device.id,
        deviceLabel: device.label,
        online: device.isOnline,
        lastSeenAt: device.lastSeenAt ?? null,
        ...(device.hostKind ? { hostKind: device.hostKind } : {}),
      });
      return { key: host.key, label: device.label, online: device.isOnline, host };
    }),
  ];
  const configured = useQueries({
    queries: machines.map((machine) => ({
      // 与 IntegrationsProvider 的「存没存凭据」同一个键:同一台机器只问一次。
      queryKey: [...ISSUE_CONNECTION_STATUS_QUERY_KEY, machine.host.key, 'configured'],
      queryFn: () => machine.host.integrations.checkConfiguredConnections(),
      enabled: machine.online && machine.key !== current.key,
      staleTime: Infinity,
      retry: false,
    })),
  });

  return (
    <section>
      <MicroLabel>{translate('integrations.devicesLabel', { name: integration.name })}</MicroLabel>
      <div className="mt-3 divide-y divide-border rounded-lg bg-background-2">
        {machines.map((machine, index) => {
          // 问不到 / 还在问 ≠ 没连(读数的仪器坏了不是阴性读数):各说各的,❌ 一律画成红点「未连接」。
          const query = machine.key === current.key ? null : configured[index];
          const known = query === null ? integration.isConfigurationKnown : query?.isSuccess === true;
          const isConfigured = query === null ? integration.isConfigured : query?.data?.[integration.id] === true;
          const state = !machine.online
            ? translate('integrations.deviceOffline')
            : query?.isError
              ? translate('integrations.deviceUnknown')
              : !known
                ? translate('integrations.checkingAccount')
                : isConfigured
                  ? translate('integrations.deviceConnected')
                  : translate('integrations.deviceNotConnected');
          return (
            <InfoRow key={machine.key} label={machine.label}>
              {machine.online && known && <StatusDot ok={isConfigured} />}
              <span className="text-foreground-muted" title={query?.isError ? String(query.error) : undefined}>
                {state}
              </span>
            </InfoRow>
          );
        })}
      </div>
      <p className="mt-2 px-1 text-xs text-foreground-muted">{translate('integrations.devicesHint')}</p>
    </section>
  );
});

function AddAccountCard({
  integration,
  label,
  detail,
}: {
  integration: IntegrationItem;
  label?: string;
  detail?: string;
}) {
  const { translate } = useSessionMessages();
  const shownDetail = detail ?? translate('integrations.connectHint', { name: integration.name });
  return (
    <button
      type="button"
      onClick={integration.onConnect}
      disabled={integration.isMutating || integration.readOnly}
      className="flex w-full items-center gap-3 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-3 text-left transition-colors hover:border-border hover:bg-row-hover active:bg-row-press disabled:cursor-not-allowed disabled:opacity-60 dark:bg-foreground/[0.03]"
      aria-label={label ?? translate('integrations.addAccountLabel', { name: integration.name })}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        {integration.isMutating ? (
          <LoadingIndicator size="inline" className="text-foreground-muted" />
        ) : (
          <Plus className="h-4 w-4 text-foreground-muted" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {label ?? translate('integrations.addAccountLabel', { name: integration.name })}
        </p>
        {shownDetail && <p className="truncate text-xs text-foreground-muted">{shownDetail}</p>}
      </div>
    </button>
  );
}
