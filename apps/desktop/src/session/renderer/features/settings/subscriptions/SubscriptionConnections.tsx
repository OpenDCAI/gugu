import { useEffect, useState } from 'react';
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
import { ConnectionActionError, errorText, sessionsBusyOf, subscriptionKey } from './subscription-queries';

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

/** 切换没成时给行摆的一句话。`gentle`=被拒而不是出错(有会话正在工作),不飘红。 */
export type SwitchNotice = { tone: 'gentle' | 'error'; text: string };

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
    mutationFn: async ({ kind, id }: { kind: 'select' | 'remove' | 'refresh'; id: string }) => {
      if (agent.id !== 'claude' && agent.id !== 'codex') throw new Error('Unsupported harness');
      const client = await getAgentConfigRuntimeClient(machine);
      if (kind === 'refresh') {
        const reading = await client.refreshAuthStatus({ providerId: agent.id, connectionId: id });
        if (!reading.success) throw new Error(errorText(reading.error));
      } else {
        const input: { providerId: 'claude' | 'codex'; connectionId: string } = { providerId: agent.id, connectionId: id };
        const result = kind === 'select' ? await client.selectConnection(input) : await client.removeConnection(input);
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
  const failure = busy
    ? translate('subscriptions.connections.busy', { count: busy.count, provider: agent.name })
    : action.error ? errorText(action.error) : null;
  const tone = busy ? 'gentle' : 'error';
  useEffect(() => { onError?.(failure === null ? null : { tone, text: failure }); }, [failure, tone, onError]);
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
