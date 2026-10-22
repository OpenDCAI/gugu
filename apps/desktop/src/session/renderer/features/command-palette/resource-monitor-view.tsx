import { Check, ChevronRight, Copy, Folder, Terminal, X } from '@/lib/icons'
import { GitBranch } from 'lucide-react'
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { closeTabsOfSession } from '@renderer/features/sessions/view/session-pane-policy';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { Spinner } from '@renderer/lib/ui/spinner';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { formatBytes } from '@renderer/utils/formatBytes';
import { cn } from '@renderer/utils/utils';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import type { ResourceAppProcess, ResourceSnapshot } from '@shared/resource-monitor';
import {
  appProcessLabel,
  buildGroups,
  entryLabel,
  formatReport,
  isLifecycleScriptEntry,
  sortAppProcesses,
  type Entry,
  type Group,
  type SessionBucket,
} from './resource-monitor-utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ResourceMonitorInternalsSection } from './resource-monitor-internals-section';

export const ResourceMonitorView = observer(function ResourceMonitorView() {
  const store = appState.resourceMonitor;
  const snapshot = store.snapshot;
  const isLoading = store.isLoadingInitialSnapshot;
  const memLabel = store.totalMemoryBytes === undefined ? '–' : formatBytes(store.totalMemoryBytes);
  const cpuLabel = store.totalCpuPercent === undefined ? '–' : `${store.totalCpuPercent.toFixed(1)}%`;
  const { translate } = useSessionMessages();
  const [changingDiagnostics, setChangingDiagnostics] = useState(false);
  const toggleDiagnostics = async () => {
    setChangingDiagnostics(true);
    try {
      await store.setInternals(!store.internals);
    } catch {
      toast({ title: translate('resourceMonitor.diagnosticsFailed'), tier: 'error' });
    } finally {
      setChangingDiagnostics(false);
    }
  };

  const groups = useMemo(() => buildGroups(snapshot?.entries ?? []), [snapshot]);
  const processes = useMemo(() => sortAppProcesses(snapshot?.appProcesses ?? []), [snapshot]);

  const hasProjects = groups.length > 0;
  const hasProcesses = processes.length > 0;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-foreground/10 px-2 py-2">
        <div className="ml-auto flex items-center gap-3 text-xs tabular-nums">
          <Stat label="CPU" value={cpuLabel} />
          <Stat label="Mem" value={memLabel} />
          <CopyReportButton snapshot={snapshot} groups={groups} />
        </div>
      </div>

      <div className="min-h-[14rem] px-1.5 py-1.5">
        {isLoading ? (
          <ResourceMonitorLoadingState />
        ) : (
          <>
            {hasProcesses && (
              <Section heading={translate('palette.application')}>
                <div className="flex flex-col">
                  {processes.map((p) => (
                    <ProcessRow key={p.pid} process={p} />
                  ))}
                </div>
              </Section>
            )}

            <Section heading={translate('palette.activeSessions')}>
              {hasProjects ? (
                <div className="flex flex-col gap-1">
                  {groups.map((g) => (
                    <ProjectRow key={g.projectId} group={g} />
                  ))}
                </div>
              ) : (
                <div className="rounded-md py-6 text-center text-xs text-foreground/40">
                  {translate('palette.noActiveSessions')}
                </div>
              )}
            </Section>
            <button
              type="button"
              aria-expanded={store.internals}
              disabled={changingDiagnostics}
              onClick={() => void toggleDiagnostics()}
              className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-foreground-muted hover:bg-row-hover disabled:opacity-50"
            >
              <ChevronRight size={14} className={store.internals ? 'rotate-90' : ''} />
              {translate('resourceMonitor.advanced')}
            </button>
            {store.internals && <ResourceMonitorInternalsSection />}
          </>
        )}
      </div>
    </>
  );
});

function ResourceMonitorLoadingState() {
  const { translate } = useSessionMessages();
  return (
    <div
      className="flex min-h-[13rem] flex-col items-center justify-center gap-2 text-xs text-foreground/50"
      role="status"
      aria-label={translate('palette.loadingResourcesLabel')}
    >
      <Spinner size="sm" className="text-foreground/60" />
      <span>{translate('palette.loadingResources')}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-foreground/40">{label} </span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-2 pb-0.5 text-micro font-medium tracking-wider text-foreground/40 uppercase">
        {heading}
      </div>
      {children}
    </div>
  );
}

function ProcessRow({ process }: { process: ResourceAppProcess }) {
  const label = appProcessLabel(process.type, process.name);
  const cpu = process.cpu;
  return (
    <div
      className="grid grid-cols-[1fr_3rem_4rem] items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-row-hover"
      title={`pid ${process.pid}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-right text-foreground/50 tabular-nums">{cpu === undefined ? '–' : `${cpu.toFixed(1)}%`}</span>
      <span className="text-right text-foreground/50 tabular-nums">
        {formatBytes(process.memory)}
      </span>
    </div>
  );
}

const ProjectRow = observer(function ProjectRow({ group }: { group: Group }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 rounded-md px-2 py-1">
        <Folder size={12} className="shrink-0 text-foreground/40" />
        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {group.projectName}
        </span>
        <span className="text-micro text-foreground/40 tabular-nums">{group.entryCount}</span>
      </div>
      <div className="ml-[14px] flex flex-col border-l border-foreground/10 pl-1.5">
        {group.sessions.map((session) => (
          <SessionRow key={session.scopeId} session={session} />
        ))}
      </div>
    </div>
  );
});

function SessionRow({ session }: { session: SessionBucket }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <GitBranch size={10} className="shrink-0 text-foreground/40" />
        <span className="flex-1 truncate text-tiny text-foreground/60">{session.sessionName}</span>
        <span className="text-micro text-foreground/40 tabular-nums">{session.entries.length}</span>
      </div>
      <div className="ml-[10px] flex flex-col border-l border-foreground/10 pl-1.5">
        {session.entries.map((entry) => (
          <AgentRow key={entry.ptySessionId} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function AgentRow({ entry }: { entry: Entry }) {
  const label = entryLabel(entry);
  const [armed, setArmed] = useState(false);

  return (
    <div className="group/agent flex items-center gap-2 rounded-md px-2 py-1 hover:bg-row-hover">
      {entry.providerId ? (
        <AgentIcon id={entry.providerId} size={14} className="size-4" />
      ) : isLifecycleScriptEntry(entry) ? (
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Terminal size={12} className="text-foreground/40" />
        </span>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      {/* 会话 id 只挂在名字这一段:挂在整行上会盖住行尾那颗停止键自己的 Tooltip。 */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5" title={entry.ptySessionId}>
        <span className="truncate text-xs text-foreground-muted">{label}</span>
        {entry.pid === undefined ? <Badge>SSH</Badge> : null}
      </div>
      <div className="relative flex shrink-0 items-center">
        <span
          className={cn(
            'text-xs text-foreground/50 tabular-nums transition-opacity group-hover/agent:opacity-0',
            armed && 'opacity-0'
          )}
        >
          {entry.cpu.toFixed(1)}% · {formatBytes(entry.memory)}
        </span>
        <StopButton
          ptySessionId={entry.ptySessionId}
          label={label}
          armed={armed}
          onArmedChange={setArmed}
        />
      </div>
    </div>
  );
}

function closeSessionTabsForPtySession(ptySessionId: string): void {
  const parsed = parsePtySessionId(ptySessionId);
  if (!parsed) return;

  const sessionView = getSessionView(parsed.projectId, parsed.scopeId);
  if (!sessionView) return;
  // Same loop the task view runs when a conversation is deleted. The copy that lived here read
  // `entry.conversationId` — a field TabEntry never had (the id sits in `entry.state`) — so Stop
  // silently closed nothing.
  closeTabsOfSession(sessionView.paneLayout, parsed.leafId);
}

function StopButton({
  ptySessionId,
  label,
  armed,
  onArmedChange,
}: {
  ptySessionId: string;
  label: string;
  armed: boolean;
  onArmedChange: (armed: boolean) => void;
}) {
  const { translate } = useSessionMessages();
  const [stopping, setStopping] = useState(false);
  const resetRef = useRef<number | null>(null);

  const clearReset = useCallback(() => {
    if (resetRef.current !== null) {
      window.clearTimeout(resetRef.current);
      resetRef.current = null;
    }
  }, []);

  useEffect(() => clearReset, [clearReset]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (stopping) return;
      if (!armed) {
        // First click arms; auto-disarm if the second click doesn't follow.
        onArmedChange(true);
        clearReset();
        resetRef.current = window.setTimeout(() => {
          onArmedChange(false);
          resetRef.current = null;
        }, 3000);
        return;
      }
      clearReset();
      setStopping(true);
      try {
        await rpc.pty.stopSession(ptySessionId);
        closeSessionTabsForPtySession(ptySessionId);
        await appState.resourceMonitor.refresh();
        setStopping(false);
        onArmedChange(false);
      } catch {
        setStopping(false);
        onArmedChange(false);
      }
    },
    [armed, stopping, ptySessionId, clearReset, onArmedChange]
  );

  if (armed) {
    return (
      <button
        type="button"
        disabled={stopping}
        onClick={handleClick}
        className="absolute top-1/2 right-0 flex h-5 -translate-y-1/2 items-center rounded-md bg-background-destructive px-1.5 text-tiny font-medium text-foreground-destructive transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={translate('palette.confirmStop', { label })}
      >
        {translate('palette.stopQuestion')}
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <button
          type="button"
          disabled={stopping}
          onClick={handleClick}
          className="absolute top-1/2 right-0 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground/50 opacity-0 transition-opacity group-hover/agent:opacity-100 hover:bg-background-destructive hover:text-foreground-destructive disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={translate('palette.stop', { label })}
        >
          <X size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{translate('palette.stopSession')}</TooltipContent>
    </Tooltip>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-background-2 px-1.5 py-px font-sans text-micro text-foreground/50">
      {children}
    </span>
  );
}

function CopyReportButton({
  snapshot,
  groups,
}: {
  snapshot: ResourceSnapshot | null;
  groups: Group[];
}) {
  const { translate } = useSessionMessages();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!snapshot || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(formatReport(snapshot, groups));
      setCopied(true);
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => {
        setCopied(false);
        resetRef.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  }, [snapshot, groups]);

  return (
    <Tooltip>
      <TooltipTrigger render={
        <button
          type="button"
          aria-disabled={snapshot ? undefined : true}
          onClick={handleCopy}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-row-hover hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-30"
          aria-label={translate('palette.copyReport')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      } />
      <TooltipContent>
        {copied ? translate('palette.copied') : translate('palette.copyReport')}
      </TooltipContent>
    </Tooltip>
  );
}
