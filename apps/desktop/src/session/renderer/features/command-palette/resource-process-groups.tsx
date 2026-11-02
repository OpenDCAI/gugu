import type { ResourceProcessGroup } from '@shared/resource-monitor';
import { formatBytes } from '@renderer/utils/formatBytes';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** Session totals and the actual adapter/engine/command PIDs that contributed to them. */
export function ResourceProcessGroups({ groups }: { groups: ResourceProcessGroup[] }) {
  const { translate } = useSessionMessages();
  return <div className="flex flex-col gap-1">
    {groups.map(group => <details key={group.id} open={group.kind === 'session'} className="text-xs text-foreground-muted">
      <summary className="grid cursor-pointer grid-cols-[1fr_4rem_5rem] items-center gap-2 rounded-md px-2 py-1 hover:bg-row-hover" title={group.sessionId ?? group.label}>
        <span className="min-w-0 truncate">{group.kind === 'runtime' ? translate('resourceMonitor.sharedRuntime', { name: group.label }) : group.label}</span>
        <span className="text-right tabular-nums">{group.cpu === undefined ? '–' : `${group.cpu.toFixed(1)}%`}</span>
        <span className="text-right tabular-nums">{formatBytes(group.memory)}</span>
      </summary>
      <div className="ml-3 border-l border-border pl-1.5">
        {group.processes.map(process => <div key={process.pid} className="grid grid-cols-[1fr_4rem_5rem] gap-2 px-2 py-0.5 text-foreground/50" title={`pid ${process.pid} · ppid ${process.ppid}`}>
          <span className="truncate">{process.name} · {process.pid}</span>
          <span className="text-right tabular-nums">{process.cpu === undefined ? '–' : `${process.cpu.toFixed(1)}%`}</span>
          <span className="text-right tabular-nums">{formatBytes(process.memory)}</span>
        </div>)}
      </div>
    </details>)}
  </div>;
}
