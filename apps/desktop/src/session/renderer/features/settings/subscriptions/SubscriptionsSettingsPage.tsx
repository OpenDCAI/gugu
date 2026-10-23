import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import type { SubscriptionUsageReading, SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins';
import { SettingsGroup, SettingsNote, SettingsPage } from '@/components/settings/SettingsPrimitives';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status';
import { refreshSpendingPower } from '@/lib/billing';
import { GuguSubscriptionRow } from './GuguSubscriptionRow';
import { SubscriptionServiceRow } from './SubscriptionServiceRow';
import { SubscriptionConnections, useSubscriptionConnections, type SwitchNotice } from './SubscriptionConnections';
import './subscriptions.css';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { PageHeader } from '@renderer/lib/components/page-header';
import { rpc } from '@renderer/lib/ipc';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { NEARLY_USED_PERCENT, payerLine, planNotes, quotaReading, unavailableText, windowLabel } from './subscription-view';
import {
  errorText,
  readUsage,
  SUBSCRIPTION_STALE_MS,
  subscriptionKey,
  useSubscriptionPlan,
} from './subscription-queries';

/**
 * 设置「订阅」页(product spec,owner 2026-10-13 定单开一页):这台电脑(或选中的那台机器)上
 * 装着的每家 Harness,用户自己买的套餐与这一期还剩多少。读数在那台机器的 agent-config worker 里跑
 * (`readSubscription` / `readSubscriptionUsage`),与「账号」那一行的登录读数同一套 CLI 与凭据。
 *
 * 打开页面读取当前连接的额度，页首刷新重问。每条读数按设备和连接分开缓存。
 */
const RECOMMENDED_IDS = new Set(['claude', 'codex', 'antigravity']);

export const SubscriptionsSettingsPage = observer(function SubscriptionsSettingsPage() {
  const { translate } = useSessionMessages();
  const selected = useSelectedRemoteDevice(settingsDeviceStore);
  const deviceId = selected?.deviceId ?? null;
  const label = selected?.device.label ?? '';
  const online = selected?.device.isOnline ?? false;
  const lastSeenAt = selected?.device.lastSeenAt ?? null;
  const hostKind = selected?.device.hostKind;
  const host = useMemo(
    () =>
      machineLibraryHost(deviceId ? { deviceId, deviceLabel: label, online, lastSeenAt, hostKind } : null),
    [deviceId, label, online, lastSeenAt, hostKind]
  );
  return (
    <SettingsPage>
      <PageHeader
        title={translate('subscriptions.title')}
        showTitleInSettings
        aside={<SubscriptionRefresh machine={deviceId} />}
        description={translate('subscriptions.description')}
        remoteDescription={(device) => translate('subscriptions.remoteDescription', { device })}
      />
      <LibraryHostProvider value={host} key={host.key}>
        <SubscriptionList machine={deviceId} />
      </LibraryHostProvider>
    </SettingsPage>
  );
});

function SubscriptionRefresh({ machine }: { machine: string | null }) {
  const { translate } = useSessionMessages();
  const queryClient = useQueryClient();
  const refreshing = useIsFetching({ queryKey: subscriptionKey(machine) }) > 0;
  return <Button variant="outline" size="sm" disabled={refreshing} data-testid="subscriptions-refresh" onClick={() => {
    refreshSpendingPower();
    void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
  }}>{refreshing ? translate('subscriptions.checking') : translate('subscriptions.refresh')}</Button>;
}

function SubscriptionList({ machine }: { machine: string | null }) {
  const { translate } = useSessionMessages();
  const { data: agents, error, isPending } = useManagementAgents();
  const installed = useMemo(
    () =>
      (agents ?? [])
        .filter((agent) => agent.reading !== 'not-detected')
        .sort(
          (a, b) =>
            Number(RECOMMENDED_IDS.has(b.id)) - Number(RECOMMENDED_IDS.has(a.id)) ||
            a.name.localeCompare(b.name)
        ),
    [agents]
  );
  return (
    <SettingsGroup
      footer={<SettingsNote>{translate('subscriptions.connections.hint')}</SettingsNote>}
    >
      {officialServicesEnabled() ? <GuguSubscriptionRow /> : null}
      {error && (
        <SettingsNote tone="danger">
          {translate('subscriptions.loadFailed', { message: errorText(error) })}
        </SettingsNote>
      )}
      {!isPending && !error && installed.length === 0 && (
        <SettingsNote>{translate('subscriptions.empty')}</SettingsNote>
      )}
      {installed.map((agent) => (
        <SubscriptionRow key={agent.id} agent={agent} machine={machine} />
      ))}
    </SettingsGroup>
  );
}

function SubscriptionRow({ agent, machine }: { agent: AgentPayload; machine: string | null }) {
  const { translate, locale } = useSessionMessages();
  const [switchNotice, setSwitchNotice] = useState<SwitchNotice | null>(null);
  const connections = useSubscriptionConnections(machine, agent.id);
  const manageable = agent.id === 'claude' || agent.id === 'codex';
  const currentConnection = connections.data?.find((connection) => connection.current);
  const connectionId = currentConnection?.id;
  const ready = !manageable || !!currentConnection;
  const plan = useSubscriptionPlan(machine, agent.id, connectionId, ready);
  const usage = useQuery({
    queryKey: subscriptionKey(machine, agent.id, 'usage', connectionId),
    queryFn: () => readUsage(machine, agent.id, false, connectionId),
    staleTime: SUBSCRIPTION_STALE_MS,
    retry: false,
    enabled: ready,
    refetchOnWindowFocus: false,
  });
  const { auth } = useAgentAuthStatus(agent.id, undefined, { machine });

  const formatDateTime = (epochMs: number) => formatWhen(epochMs, locale);
  const description = plan.data
    ? payerLine(plan.data, translate, false)
    : plan.error
      ? translate('subscriptions.unavailable.error', { message: errorText(plan.error) })
      : translate('subscriptions.checking');
  const notes = plan.data ? planNotes(plan.data, translate, (at) => formatDate(at, locale)) : [];
  const reading = quotaReading(plan.data, usage.data);

  return (
    <SubscriptionServiceRow
      testId={`subscription-row-${agent.id}`}
      logo={<AppIcon id={agent.id} size={24} />}
      name={agent.name}
      badge={plan.data?.plan ?? (plan.data?.payer === 'api-key' || plan.data?.payer === 'custom-endpoint' ? 'API' : undefined)}
      identity={
        auth?.status.kind === 'unauthenticated' && auth.status.reason === 'expired'
          ? translate('subscriptions.connections.expired')
          : currentConnection?.kind === 'api-key'
            ? currentConnection.name || description
            : auth?.status.kind === 'authenticated' && auth.status.account ? auth.status.account : description
      }
      scope={
        manageable && connections.data
          ? translate('subscriptions.connections.count', { count: String(connections.data.length) })
          : translate('subscriptions.connections.device')
      }
      action={manageable ? <SubscriptionConnections agent={agent} machine={machine} onError={setSwitchNotice} /> : undefined}
      notice={switchNotice ? <SwitchNoticeLine notice={switchNotice} /> : undefined}
    >
      <UsageBlock
        agentId={agent.id}
        reading={reading}
        pending={ready ? usage.isPending : connections.isPending}
        error={connections.error ?? usage.error}
        formatDateTime={formatDateTime}
      />
      {(notes.length > 0 || reading?.kind === 'windows') && <div className="subscription-reading-footer">
        <div>{notes.map(note => <span key={note}>{note}</span>)}</div>
        {reading?.kind === 'windows' && <span data-testid={`subscription-read-at-${agent.id}`}>{formatAgo(reading.readAt, locale)}</span>}
      </div>}
    </SubscriptionServiceRow>
  );
}

/** 被拒(有会话正在工作)是平常事,用安静的字色说;真出错才红。 */
function SwitchNoticeLine({ notice }: { notice: SwitchNotice }) {
  return notice.tone === 'gentle'
    ? <p className="subscription-note" role="status">{notice.text}</p>
    : <p className="subscription-error" role="alert">{notice.text}</p>;
}

function UsageBlock({
  agentId,
  reading,
  pending,
  error,
  formatDateTime,
}: {
  agentId: string;
  reading: SubscriptionUsageReading | undefined;
  pending: boolean;
  error: Error | null;
  formatDateTime: (epochMs: number) => string;
}) {
  const { translate } = useSessionMessages();
  if (pending)
    return <div className="mt-1 text-xs text-foreground-passive">{translate('subscriptions.checking')}</div>;
  if (error) {
    return (
      <div className="mt-1 text-xs text-foreground-warning">
        {translate('subscriptions.unavailable.error', { message: error.message })}
      </div>
    );
  }
  if (!reading) return null;
  if (reading.kind === 'windows') {
    return (
      <>
      <div className="subscription-quota-grid" data-testid={`subscription-usage-${agentId}`}>
        {reading.windows.map((window, index) => (
          <UsageBar
            key={`${window.group ?? ''}-${window.windowMinutes ?? ''}-${index}`}
            window={window}
            formatDateTime={formatDateTime}
          />
        ))}
      </div>
      {reading.refreshError && <p className="subscription-error" role="alert">{reading.refreshError}</p>}
      </>
    );
  }
  const text = unavailableText(reading, translate);
  if (!text && !reading.consoleUrl) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-foreground-passive"
      data-testid={`subscription-unavailable-${agentId}`}
    >
      {text && <span>{text}</span>}
      {reading.consoleUrl && (
        <button
          type="button"
          className="text-foreground-muted underline-offset-2 hover:underline"
          onClick={() => void rpc.app.openExternal(reading.consoleUrl!)}
        >
          {translate('subscriptions.openConsole')}
        </button>
      )}
    </div>
  );
}

function UsageBar({
  window,
  formatDateTime,
}: {
  window: SubscriptionUsageWindow;
  formatDateTime: (epochMs: number) => string;
}) {
  const { translate } = useSessionMessages();
  const remaining = 100 - Math.min(100, Math.max(0, window.usedPercent));
  const reset =
    window.resetsAt !== undefined
      ? translate('subscriptions.resets', { time: formatDateTime(window.resetsAt) })
      : null;
  return (
    <div className="subscription-quota" data-warning={window.usedPercent >= NEARLY_USED_PERCENT || undefined}>
      <div className="subscription-quota-label">
        <span>{translate('subscriptions.remaining', { window: windowLabel(window, translate) })}</span>
        <strong>
          {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(remaining)}
          <small>%</small>
        </strong>
      </div>
      <div
        className="subscription-meter"
        role="meter"
        aria-label={windowLabel(window, translate)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
      >
        <i style={{ width: `${remaining}%` }} />
      </div>
      {reset && <p>{reset}</p>}
    </div>
  );
}

function formatWhen(epochMs: number, locale: string): string {
  const date = new Date(epochMs);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDate(epochMs: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

function formatAgo(epochMs: number, locale: string): string {
  const seconds = Math.round((epochMs - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return format.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}
