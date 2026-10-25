import { messageForUser } from '@/lib/userFacingError';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { formatBytes } from '@renderer/utils/formatBytes';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  internalsRows,
  PERF_COUNTER_KEYS,
  type InternalsRow,
} from './resource-monitor-internals';

const SOURCE_LABEL = {
  'main-window': 'palette.internalsMainWindow',
  app: 'palette.internalsApp',
  other: 'palette.internalsOther',
} as const;

const COUNTER_LABEL = {
  imTransactions: 'palette.counterImTransactions',
  presenceBatches: 'palette.counterPresenceBatches',
  presenceIds: 'palette.counterPresenceIds',
  contactsProviderRenders: 'palette.counterContactsRenders',
} as const;

const log = rendererLogger('resource-monitor/internals');

const ROW = 'grid grid-cols-[minmax(0,1fr)_8.5rem_8.5rem_4.5rem] items-center gap-2 whitespace-nowrap rounded-md px-2 py-1 text-xs';

export const ResourceMonitorInternalsSection = observer(function ResourceMonitorInternalsSection() {
  const { snapshot, previousSnapshot } = appState.resourceMonitor;
  const { translate } = useSessionMessages();
  const rows = useMemo(() => (snapshot ? internalsRows(previousSnapshot, snapshot) : []), [snapshot, previousSnapshot]);
  const counters = rows.find((row) => row.counters)?.counterRates;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-micro font-medium tracking-wider text-foreground/40 uppercase">
        <span>{translate('palette.internals')}</span>
        <DeepSampleButton />
      </div>
      <div className={`${ROW} text-foreground/40`}>
        <span />
        <span className="text-right">V8</span>
        <span className="text-right">Blink</span>
        <span className="text-right">{translate('palette.internalsPrivate')}</span>
      </div>
      {rows.map((row) => (
        <RendererRow key={row.pid} row={row} />
      ))}
      <div className="grid grid-cols-2 gap-x-4 px-2 py-1 text-xs text-foreground-muted">
        {PERF_COUNTER_KEYS.map((key) => (
          <div key={key} className="flex justify-between">
            <span>{translate(COUNTER_LABEL[key])}</span>
            <span className="text-foreground/50 tabular-nums">
              {counters ? `${counters[key].toFixed(1)}/s` : '–'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

function used(usedBytes: number, totalBytes: number): string {
  return `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}`;
}

function RendererRow({ row }: { row: InternalsRow }) {
  const { translate } = useSessionMessages();
  return (
    // A missing reading shows as –; why it is missing is diagnostic detail, kept in the hover text and the deep sample.
    <div
      className={`${ROW} text-foreground-muted hover:bg-row-hover`}
      title={row.unavailable ? `pid ${row.pid} · ${row.unavailable}` : `pid ${row.pid}`}
    >
      <span className="truncate">{translate(SOURCE_LABEL[row.source])}</span>
      <span className="text-right text-foreground/50 tabular-nums">
        {row.v8 ? used(row.v8.usedBytes, row.v8.totalBytes) : '–'}
      </span>
      <span className="text-right text-foreground/50 tabular-nums">
        {row.oilpan ? used(row.oilpan.allocatedBytes, row.oilpan.totalBytes) : '–'}
      </span>
      <span className="text-right text-foreground/50 tabular-nums">
        {row.privateBytes === undefined ? '–' : formatBytes(row.privateBytes)}
      </span>
    </div>
  );
}

function DeepSampleButton() {
  const { translate } = useSessionMessages();
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    try {
      const res = await rpc.resourceMonitor.deepSample(translate('palette.deepSampleTitle'));
      if (res.success && res.data) toast({ title: translate('palette.deepSampleSaved'), description: res.data, tier: 'success' });
    } catch (error) {
      log.error({ error: String(error) }, 'deep sample failed');
      toast({ title: messageForUser(error), tier: 'error' });
    } finally {
      setRunning(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={running}
      className="ml-auto rounded px-2 normal-case tracking-normal text-foreground/60 transition-colors hover:bg-row-hover hover:text-foreground disabled:opacity-50"
    >
      {translate(running ? 'palette.deepSampleRunning' : 'palette.deepSample')}
    </button>
  );
}
