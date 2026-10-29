import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, MoreHorizontal, Plus } from '@/lib/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Dialog, DialogContent, DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from '@renderer/lib/ui/dropdown-menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { forceRefreshHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { harnessModelCredentialKey } from '@renderer/lib/stores/use-harness-model-credential';
import { resolveSignInMethod } from '../agents-page/agent-account';
import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins';
import { ConnectionActionError, errorText, readUsage, sessionsBusyOf, SUBSCRIPTION_STALE_MS, subscriptionKey } from './subscription-queries';
import { NEARLY_USED_PERCENT, windowLabel } from './subscription-view';

function connectionsKey(machine: string | null, providerId: string) {
  return ['subscriptions', machine ?? 'local', providerId, 'connections'];
}

export function useSubscriptionConnections(machine: string | null, providerId: string) {
  return useQuery({
    queryKey: connectionsKey(machine, providerId),
    queryFn: async () => {
      const result = await (await getAgentConfigRuntimeClient(machine)).listConnections({ providerId });
      if (!result.success) throw new Error(errorText(result.error));
      return result.data;
    },
    enabled: providerId === 'claude' || providerId === 'codex',
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * 切换没成时给行摆的一句话。`gentle`=被拒而不是出错(有会话正在工作),不飘红。
 * `closeAndSwitch`:被拒时的出路 —— 一键把正在工作的会话也关掉、接着切(额度用完时它们本来也跑不下去)。
 */
export type SwitchNotice = { tone: 'gentle' | 'error'; text: string; closeAndSwitch?: () => void };

/** `onError` 把切换失败的原因交给行去摆(整行宽度);这里只管菜单与按钮,❌ 在窄的操作列里画长句。 */
export function SubscriptionConnections({ agent, machine, onError }: {
  agent: AgentPayload;
  machine: string | null;
  onError?: (notice: SwitchNotice | null) => void;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();
  const showSignIn = useShowModal('agentSignInModal');
  const host = useLibraryHost();
  const connections = useSubscriptionConnections(machine, agent.id);
  const method = resolveSignInMethod(agent.capabilities);
  const canSignIn = method?.kind === 'cli-login' && (!machine || !!method.headlessArgs);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) });
    void queryClient.invalidateQueries({ queryKey: harnessModelCredentialKey(agent.id) });
  };
  const action = useMutation({
    mutationFn: async ({ kind, id, stopBusySessions }: { kind: 'select' | 'remove' | 'refresh'; id: string; stopBusySessions?: true }) => {
      if (agent.id !== 'claude' && agent.id !== 'codex') throw new Error('Unsupported harness');
      const client = await getAgentConfigRuntimeClient(machine);
      if (kind === 'refresh') {
        const reading = await client.refreshAuthStatus({ providerId: agent.id, connectionId: id });
        if (!reading.success) throw new Error(errorText(reading.error));
      } else {
        const input: { providerId: 'claude' | 'codex'; connectionId: string } = { providerId: agent.id, connectionId: id };
        const result = kind === 'select'
          ? await client.selectConnection(stopBusySessions ? { ...input, stopBusySessions } : input)
          : await client.removeConnection(input);
        if (!result.success) throw new ConnectionActionError(result.error);
      }
      // Commit the connection first. Model refresh failure must not disguise a successful switch.
      refresh();
      setOpen(false);
      if (kind === 'select' || connections.data?.some(c => c.current && c.id === id)) {
        await forceRefreshHarnessModelCatalog(queryClient, agent.id, 'acp', machine);
      }
    },
  });
  // 跟最近一次动作走:新动作一开始 `action.error` 就清空,重叠的两次里先失败的那次不会把原因留下。
  const busy = sessionsBusyOf(action.error);
  // 带着「关掉」还被拒 = 那台机器上的咕咕不认这一格(旧版本):说清楚去更新，❌ 再摆一个按了没反应的按钮。
  const closeUnsupported = !!busy && action.variables?.stopBusySessions === true;
  const failure = closeUnsupported
    ? translate('subscriptions.connections.closeUnsupported')
    : busy
      ? translate('subscriptions.connections.busy', { count: busy.count, provider: agent.name })
      : action.error ? errorText(action.error) : null;
  const tone = busy && !closeUnsupported ? 'gentle' : 'error';
  // 被拒的那次切的是哪个连接:「关掉并切换」原样再切一次。
  const refusedId = busy && !closeUnsupported && action.variables?.kind === 'select' ? action.variables.id : null;
  const { mutate } = action;
  const closeAndSwitch = useCallback(() => {
    if (refusedId) mutate({ kind: 'select', id: refusedId, stopBusySessions: true });
  }, [refusedId, mutate]);
  useEffect(() => {
    onError?.(failure === null ? null : { tone, text: failure, ...(refusedId ? { closeAndSwitch } : {}) });
  }, [failure, tone, refusedId, closeAndSwitch, onError]);
  const signIn = (connectionId: string) => {
    if (!method || !canSignIn) return;
    setOpen(false);
    const finished = () => action.mutate({ kind: 'refresh', id: connectionId });
    showSignIn({
      providerId: agent.id, providerName: agent.name, connectionId,
      steps: [{ methodId: method.id }],
      ...(machine ? { remote: { deviceId: machine, deviceLabel: host.remote?.deviceLabel ?? '', headless: true, command: agent.id } } : {}),
      onSuccess: finished, onClose: finished,
    });
  };
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="xs" disabled={action.isPending} data-testid={`subscription-switch-${agent.id}`} />}>
          {translate('subscriptions.connections.switch')}
          <ChevronDown className="ml-1 size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="subscription-connection-menu">
          {connections.isPending && <p className="p-2 text-xs">{translate('subscriptions.checking')}</p>}
          {connections.error && <p className="subscription-error p-2" role="alert">{errorText(connections.error)}</p>}
          <DropdownMenuRadioGroup value={connections.data?.find(c => c.current)?.id ?? ''} onValueChange={id => action.mutate({ kind: 'select', id })}>
            {open && connections.data?.map(connection => (
              <ConnectionOption key={connection.id} connection={connection} agent={agent} machine={machine}
                busy={action.isPending}
                onRemove={() => action.mutate({ kind: 'remove', id: connection.id })} />
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="subscription-add-connection" onClick={() => { setOpen(false); setAdding(true); }}>
            <Plus className="size-4" />{translate('subscriptions.connections.add')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>{translate('subscriptions.connections.addTitle', { provider: agent.name })}</DialogTitle></DialogHeader>
          <DialogContentArea>
            <ConnectionForm agent={agent} machine={machine} canSignIn={canSignIn} onCreated={connection => {
              refresh(); setAdding(false);
              if (connection.kind === 'account') signIn(connection.id);
              else setOpen(true);
            }} />
          </DialogContentArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectionOption({ connection, agent, machine, busy, onRemove }: {
  connection: HarnessConnection; agent: AgentPayload; machine: string | null; busy: boolean;
  onRemove: () => void;
}) {
  const { translate } = useSessionMessages();
  const details = useQuery({
    queryKey: [...connectionsKey(machine, agent.id), connection.id],
    queryFn: async () => {
      const client = await getAgentConfigRuntimeClient(machine);
      const input = { providerId: agent.id, connectionId: connection.id };
      const [status, plan] = await Promise.all([client.refreshAuthStatus(input), client.readSubscription(input)]);
      if (!status.success) throw new Error(errorText(status.error));
      return { status: status.data, plan: plan.success ? plan.data : null };
    },
    staleTime: 30_000, retry: false,
  });
  // 不切过去也看得到这个号还剩多少(10-30 owner):按连接读，与「订阅」行同一把键、同一份读数。
  const usage = useQuery({
    queryKey: subscriptionKey(machine, agent.id, 'usage', connection.id),
    queryFn: () => readUsage(machine, agent.id, false, connection.id),
    staleTime: SUBSCRIPTION_STALE_MS, retry: false, refetchOnWindowFocus: false,
    // 没登录的号没有额度可读;API key 的余量只在厂商后台。
    enabled: connection.kind !== 'api-key' && details.data?.status.kind === 'authenticated',
  });
  const quota = usage.data?.kind === 'windows' ? remainingLine(usage.data.windows, translate) : null;
  const nearlyUsed = usage.data?.kind === 'windows' && usage.data.windows.some((window) => window.usedPercent >= NEARLY_USED_PERCENT);
  const status = details.data?.status;
  const name = connection.kind === 'native' ? translate('subscriptions.connections.existing') : connection.name;
  const description = status?.kind === 'authenticated' && status.account ? status.account
    : connection.kind === 'api-key' ? connection.endpoint ? new URL(connection.endpoint).host : translate('subscriptions.connections.officialApi')
    : status?.kind === 'unauthenticated' ? translate(status.reason === 'expired' ? 'subscriptions.connections.expired' : 'subscriptions.connections.signedOut')
    : details.isPending ? translate('subscriptions.checking') : translate('subscriptions.connections.account');
  return (
    <div className="subscription-connection-option" data-testid={`connection-${connection.id}`}>
      <DropdownMenuRadioItem value={connection.id} data-testid={`connection-use-${connection.id}`}
        disabled={busy || details.isPending || (connection.kind === 'account' && status?.kind !== 'authenticated')}
        className="subscription-connection-choice">
        <span><span className="subscription-connection-name">{name}{details.data?.plan?.plan && <span className="subscription-plan-badge">{details.data.plan.plan}</span>}</span>
          <span className="subscription-connection-description block">{description}</span>
          {quota && <span className="subscription-connection-quota block" data-testid={`connection-quota-${connection.id}`} data-warning={nearlyUsed || undefined}>{quota}</span>}
          {details.error && <span className="subscription-error block">{errorText(details.error)}</span>}
        </span>
      </DropdownMenuRadioItem>
      {connection.kind !== 'native' && !connection.current && <DropdownMenuSub>
        <DropdownMenuSubTrigger aria-label={translate('subscriptions.connections.options', { name })} className="subscription-connection-options"><MoreHorizontal className="size-4" /></DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem disabled={busy} variant="destructive" onClick={onRemove}>{translate('subscriptions.connections.remove')}</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>}
    </div>
  );
}

/** 「5 小时剩余 29% · 每周剩余 50%」—— 与「订阅」行的额度条同一种算法，只是压成一行。 */
function remainingLine(windows: readonly SubscriptionUsageWindow[], translate: ReturnType<typeof useSessionMessages>['translate']): string {
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  return windows
    .map((window) => `${translate('subscriptions.remaining', { window: windowLabel(window, translate) })} ${percent.format(100 - Math.min(100, Math.max(0, window.usedPercent)))}%`)
    .join(' · ');
}

function ConnectionForm({
  agent,
  machine,
  canSignIn,
  onCreated,
}: {
  agent: AgentPayload;
  machine: string | null;
  canSignIn: boolean;
  onCreated: (connection: HarnessConnection) => void;
}) {
  const { translate } = useSessionMessages();
  const [kind, setKind] = useState<'account' | 'api-key'>(canSignIn ? 'account' : 'api-key');
  const [thirdParty, setThirdParty] = useState(false);
  const create = useMutation({
    mutationFn: async (form: HTMLFormElement) => {
      const data = new FormData(form);
      if (agent.id !== 'claude' && agent.id !== 'codex') throw new Error('Unsupported harness');
      const result = await (
        await getAgentConfigRuntimeClient(machine)
      ).createConnection({
        providerId: agent.id,
        kind,
        name: String(data.get('name') ?? '').trim() || undefined,
        ...(kind === 'api-key'
          ? {
              apiKey: String(data.get('apiKey') ?? '').trim(),
              ...(thirdParty ? { endpoint: String(data.get('endpoint') ?? '').trim() } : {}),
            }
          : {}),
      });
      if (!result.success) throw new Error(errorText(result.error));
      form.reset();
      return result.data;
    },
    onSuccess: onCreated,
  });
  return (
    <form
      className="subscription-connection-form"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(event.currentTarget);
      }}
    >
      <div className="flex gap-2" role="group" aria-label={translate('subscriptions.connections.method')}>
        {canSignIn && (
          <Button
            type="button"
            variant={kind === 'account' ? 'secondary' : 'ghost'}
            aria-pressed={kind === 'account'}
            onClick={() => setKind('account')}
          >
            {translate('subscriptions.connections.account')}
          </Button>
        )}
        <Button
          type="button"
          variant={kind === 'api-key' ? 'secondary' : 'ghost'}
          aria-pressed={kind === 'api-key'}
          onClick={() => setKind('api-key')}
        >
          API Key
        </Button>
      </div>
      {kind === 'api-key' ? (
        <>
          <label>
            API Key
            <Input
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
            />
          </label>
          <label className="subscription-checkbox">
            <input
              type="checkbox"
              checked={thirdParty}
              onChange={(event) => setThirdParty(event.target.checked)}
            />
            {translate('subscriptions.connections.thirdParty')}
          </label>
          {thirdParty && (
            <label>
              {translate('subscriptions.connections.endpoint')}
              <Input
                name="endpoint"
                type="url"
                required
                placeholder={agent.id === 'codex' ? 'https://api.example.com/v1' : 'https://api.example.com'}
              />
            </label>
          )}
        </>
      ) : (
        <p className="subscription-connection-description">
          {translate('subscriptions.connections.accountHint')}
        </p>
      )}
      <label>
        {translate('subscriptions.connections.remark')}
        <Input
          name="name"
          maxLength={80}
          placeholder={translate('subscriptions.connections.remarkPlaceholder')}
        />
      </label>
      <p className="subscription-connection-description">{translate('subscriptions.connections.private')}</p>
      {create.error && (
        <p className="subscription-error" role="alert">
          {errorText(create.error)}
        </p>
      )}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending
          ? translate('subscriptions.connections.saving')
          : kind === 'account'
            ? translate('subscriptions.connections.addAndSignIn')
            : translate('subscriptions.connections.save')}
      </Button>
    </form>
  );
}
