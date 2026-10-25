import { messageForUser } from '@/lib/userFacingError';
import { Copy, Globe, RefreshCw, Unplug, X } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import type { SessionpageListeningPort } from '@gugu/session-core/session-record/contract';
import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { Input } from '@renderer/lib/ui/input';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { MANUAL_PORT_HOLDER, remotePortsChangedChannel, type RemotePortsSnapshot } from '@shared/remote-ports';
import { remoteHostsStore } from '../remote-hosts-store';
import { remotePortFailureText } from './remote-page-copy';
import { mergePortRows, parsePortInput, type RemotePortRow } from './remote-ports-model';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { useWorkspaceSurface, useWorkspaceViewModel } from '@renderer/features/sessions/session-view-context';
import { machineRegistry } from '@renderer/lib/machine-routing';


/** 端口一格只认「哪台机器、哪条会话」(会话 = 任务:一个任务一条会话)。本机任务没有这一格 = null。 */
type PortsScope = { viewId: string; deviceId: string; sessionId: string };

function portsScope(ctx: SessionTabContext): PortsScope | null {
  const deviceId = machineRegistry.machineOf(ctx.projectId);
  return deviceId ? { viewId: ctx.viewId, deviceId, sessionId: ctx.sessionId } : null;
}

const EMPTY_SNAPSHOT: RemotePortsSnapshot = { forwards: [], detected: [] };

export const TabContent = observer(function RemotePortsTabContent({ host, ctx }: TabContentProps) {
  const activeTab = host.resolvedTabs.find((tab) => tab.isActive && tab.kind === 'remote-ports');
  const scope = portsScope(ctx as SessionTabContext);
  if (!activeTab || !scope) return null;
  return <RemotePortsBody ctx={scope} />;
});

const RemotePortsBody = observer(function RemotePortsBody({ ctx }: { ctx: PortsScope }) {
  // 那台机器离线:这一格照样在,只是说「离线,上次在线 X」;回来之后自己接上。
  const unreachable = useWorkspaceSurface().unreachableLabel;
  const view = useWorkspaceViewModel();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="remote-ports-tab">
      {unreachable ? (
        <EmptyState label={unreachable} />
      ) : (
        <RemotePortsView
          ctx={ctx}
          onOpen={(port) => view.showPage(`http://localhost:${port}/`, { preview: false, reload: false })}
        />
      )}
    </div>
  );
});

const RemotePortsView = observer(function RemotePortsView({ ctx, onOpen }: { ctx: PortsScope; onOpen: (port: number) => void }) {
  const { translate } = useSessionMessages();
  const device = remoteHostsStore.device(ctx.deviceId)?.label ?? ctx.deviceId;
  const [snapshot, setSnapshot] = useState<RemotePortsSnapshot>(EMPTY_SNAPSHOT);
  const [listening, setListening] = useState<SessionpageListeningPort[]>([]);
  const [supported, setSupported] = useState(true);
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState(false);

  const readSnapshot = useCallback(() => {
    void rpc.remotePorts
      .list({ deviceId: ctx.deviceId })
      .then((result) => {
        if (result.success) setSnapshot(result.data);
      })
      .catch(() => undefined);
  }, [ctx.deviceId]);

  const checkListening = useCallback(() => {
    setChecking(true);
    void rpcOn(ctx.deviceId)
      .machine.listeningPorts()
      .then((result) => {
        if (!result.success) throw new Error(result.error.message);
        setSupported(result.data.supported);
        setListening(result.data.ports);
      })
      .catch((error: unknown) => {
        // 此刻够不着:表上照样有转着的与输出里发现的,只记日志。
        log.warn('[remote-ports] listening ports not read', { deviceId: ctx.deviceId, error: String(error) });
      })
      .finally(() => setChecking(false));
  }, [ctx.deviceId]);

  useEffect(() => {
    readSnapshot();
    checkListening();
    return events.on(remotePortsChangedChannel, readSnapshot, ctx.deviceId);
  }, [ctx.deviceId, readSnapshot, checkListening]);

  const rows = mergePortRows(snapshot, listening);

  const forward = async () => {
    const port = parsePortInput(draft);
    if (port === null) {
      setDraftError(translate('remotePorts.invalidPort'));
      return;
    }
    setDraftError(null);
    setForwarding(true);
    try {
      const result = await rpc.remotePorts.open({
        deviceId: ctx.deviceId,
        sessionId: ctx.sessionId,
        remotePort: port,
        holder: MANUAL_PORT_HOLDER,
      });
      if (result.success) setDraft('');
      else {
        const reason = result.error.type === 'failed' ? result.error.reason : 'unknown';
        setDraftError(remotePortFailureText(reason, port, device, translate));
      }
    } finally {
      setForwarding(false);
    }
  };

  const header = (
    <div className={cn(panelHeaderBarClass, 'gap-1')}>
      <form
        className="flex min-w-0 flex-1 items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void forward();
        }}
      >
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDraftError(null);
          }}
          inputMode="numeric"
          aria-invalid={draftError ? true : undefined}
          placeholder={translate('remotePorts.forwardPlaceholder')}
          aria-label={translate('remotePorts.forwardPlaceholder')}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button type="submit" size="xs" variant="outline" disabled={forwarding || !draft.trim()}>
          {forwarding ? <LoadingIndicator size="inline" /> : translate('remotePorts.forward')}
        </Button>
      </form>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={translate('remotePorts.refresh')}
        title={translate('remotePorts.refresh')}
        onClick={() => {
          readSnapshot();
          checkListening();
        }}
      >
        {checking ? <LoadingIndicator size="inline" /> : <RefreshCw className="size-3.5" />}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {header}
      {draftError && <div className="shrink-0 px-3 pt-2 text-xs text-foreground-destructive">{draftError}</div>}
      {!supported && <div className="shrink-0 px-3 pt-2 text-xs text-foreground-passive">{translate('remotePorts.notLinux', { device })}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          checking ? (
            <div className="flex h-full items-center justify-center text-xs text-foreground-muted">
              <LoadingIndicator label={translate('task.loading')} ariaLabel={translate('task.loading')} />
            </div>
          ) : (
            <EmptyState label={translate('remotePorts.empty', { device })} />
          )
        ) : (
          <div role="table" className="px-2 py-2 text-xs">
            <div role="row" className="grid grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-2 px-2 pb-1 text-foreground-passive">
              <span role="columnheader">{translate('remotePorts.col.port')}</span>
              <span role="columnheader">{translate('remotePorts.col.local')}</span>
              <span role="columnheader">{translate('remotePorts.col.process')}</span>
              <span role="columnheader">{translate('remotePorts.col.origin')}</span>
            </div>
            {rows.map((row) => (
              <RemotePortRowView
                key={row.remotePort}
                row={row}
                deviceId={ctx.deviceId}
                onOpen={() => onOpen(row.remotePort)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function RemotePortRowView({ row, deviceId, onOpen }: { row: RemotePortRow; deviceId: string; onOpen: () => void }) {
  const { translate } = useSessionMessages();
  const local =
    row.state === 'ready' && row.localPort !== null
      ? `localhost:${row.localPort}`
      : translate(row.state === 'connecting' ? 'remotePorts.state.connecting' : row.state === 'failed' ? 'remotePorts.state.failed' : 'remotePorts.state.idle');
  const forwarded = row.state === 'ready' || row.state === 'connecting';
  const copy = () => {
    if (row.localPort === null) return;
    void rpc.app
      .clipboardWriteText(`http://localhost:${row.localPort}/`)
      .then(() => toast({ title: translate('externalLink.linkCopied') }))
      .catch((error) => { log.error('remote port URL copy failed', { error }); toast({ title: messageForUser(error), tier: 'error' }); });
  };
  return (
    <div
      role="row"
      className="group grid h-8 grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-2 rounded-md px-2 hover:bg-row-hover"
      onDoubleClick={onOpen}
    >
      <span role="cell" className="font-mono text-foreground">
        {row.remotePort}
      </span>
      <span role="cell" className={cn('truncate', row.state === 'failed' ? 'text-foreground-destructive' : row.state === 'ready' ? 'text-foreground' : 'text-foreground-muted')}>
        {row.state === 'connecting' ? (
          <span className="inline-flex items-center gap-1">
            <LoadingIndicator size="inline" />
            {local}
          </span>
        ) : (
          local
        )}
      </span>
      <span role="cell" className="truncate text-foreground-muted">
        {row.process ?? ''}
      </span>
      <span role="cell" className="relative flex min-w-0 items-center">
        <span className="truncate text-foreground-muted group-hover:invisible group-focus-within:invisible">
          {row.sources.map((source) => translate(`remotePorts.origin.${source}`)).join(' · ')}
        </span>
        <span className="invisible absolute inset-y-0 right-0 flex items-center gap-1 group-hover:visible group-focus-within:visible">
          <RowAction label={translate('remotePorts.open')} onClick={onOpen}>
            <Globe />
          </RowAction>
          {row.state === 'ready' && (
            <RowAction label={translate('remotePorts.copy')} onClick={copy}>
              <Copy />
            </RowAction>
          )}
          {forwarded ? (
            <RowAction
              label={translate('remotePorts.stop')}
              onClick={() => void rpc.remotePorts.stop({ deviceId, remotePort: row.remotePort }).catch(() => undefined)}
            >
              <Unplug />
            </RowAction>
          ) : (
            row.sources.some((source) => source === 'terminal' || source === 'agent') && (
              <RowAction
                label={translate('remotePorts.remove')}
                onClick={() => void rpc.remotePorts.forget({ deviceId, remotePort: row.remotePort }).catch(() => undefined)}
              >
                <X />
              </RowAction>
            )
          )}
        </span>
      </span>
    </div>
  );
}
