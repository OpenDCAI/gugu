import { messageForUser } from '@/lib/userFacingError';
import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { formatBytes } from '@renderer/utils/formatBytes';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ResourceHistory, ResourcePoint, ResourceSnapshot } from '@shared/resource-monitor';
import { rendererLogger } from '@/lib/log';
import { Button } from '@/components/ui/Button';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { ResourceMonitorView } from '@renderer/features/command-palette/resource-monitor-view';
import { tokenColor, useChartTheme } from '@/components/usage/useChartTheme';
import './resource-timeline.css';
const log = rendererLogger('resource-monitor/timeline');
const VChart = lazy(() => import('@visactor/react-vchart').then((m) => ({ default: m.VChart })));
const CHART_OPTIONS = { mode: 'desktop-browser' as const };

type Range = 'all' | '15m' | '1h';
const RANGE_MS: Record<Range, number> = { all: 0, '15m': 900_000, '1h': 3_600_000 };

/**
 * The resource monitor page body (and, compact, the floating window): headline numbers, the two charts, and one
 * process table that shows live data until a moment on a chart is picked, then that moment until "Back to live".
 */
export const ResourceTimeline = observer(function ResourceTimeline({ compact = false, live = false, onFloat }: { compact?: boolean; live?: boolean; onFloat?: () => void }) {
  const { translate: t } = useSessionMessages();
  const store = appState.resourceMonitor;
  const snapshot = store.snapshot;
  const [history, setHistory] = useState<ResourceHistory | null>(null);
  const [selected, setSelected] = useState<ResourceSnapshot | null>(null);
  const [range, setRange] = useState<Range>('all');
  const tick = snapshot ? Math.floor(snapshot.timestamp / 5000) : null;
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const last = history?.points.at(-1);
  const data = useMemo(() => timelineData(history?.points ?? []), [history]);
  const peak = useMemo(() => ({ cpu: peakOf(history?.points, 'cpu'), memory: peakOf(history?.points, 'memory') }), [history]);
  // Live, the headline follows the live sample like the table below it (the last recorded point until the first one
  // arrives); off, it is the last recorded point — the store keeps its final snapshot after monitoring stops.
  const now = live ? { cpu: store.totalCpuPercent ?? last?.cpu, memory: store.totalMemoryBytes ?? last?.memory } : { cpu: last?.cpu, memory: last?.memory };
  const ranges = (['15m', '1h', 'all'] as const).map((value) => ({ value, label: t(value === 'all' ? 'resourceMonitor.all' : value === '1h' ? 'resourceMonitor.range1h' : 'resourceMonitor.range15m') }));
  const labels = { cpu: t('resourceMonitor.cpuOneCore'), memory: t('resourceMonitor.memoryRss') };
  const fail = (e: unknown) => { log.error({ error: e }, 'resource history request failed'); setError(messageForUser(e)); };
  useEffect(() => {
    let active = true;
    const until = Date.now();
    void rpc.resourceMonitor.history(RANGE_MS[range] ? until - RANGE_MS[range] : 0, until).then((res) => {
      if (active) { setHistory(res.data); setError(''); }
    }).catch((e: unknown) => { if (active) fail(e); });
    return () => { active = false; };
  }, [tick, range, revision]);
  const action = async (kind: 'export' | 'clear') => {
    try {
      if (kind === 'export') await rpc.resourceMonitor.exportHistory(t('resourceMonitor.export'));
      else { await rpc.resourceMonitor.clearHistory(); setHistory(null); setSelected(null); const res = await rpc.resourceMonitor.history(); setHistory(res.data); }
    } catch (e) { fail(e); }
  };
  const select = (id: number) => { void rpc.resourceMonitor.point(id).then((res) => {
    setSelected(res.data); if (!res.data) setError(t('resourceMonitor.expired'));
  }).catch(fail); };
  const tiles = [
    { key: 'cpu' as const, label: 'CPU', value: cpuText(now.cpu), note: `${t('resourceMonitor.oneCore')} · ${t('resourceMonitor.peak', { value: cpuText(peak.cpu) })}` },
    { key: 'memory' as const, label: t('resourceMonitor.memory'), value: memoryText(now.memory), note: `${t('resourceMonitor.rssSum')} · ${t('resourceMonitor.peak', { value: memoryText(peak.memory) })}` },
  ];
  const chart = (metric: 'cpu' | 'memory', height: number) => <div aria-label={labels[metric]} style={{ height }}><TimelineChart data={data} metric={metric} compact={compact} select={select} labels={labels} /></div>;

  if (compact) return <section className="space-y-3 text-xs" aria-label={t('resourceMonitor.timeline')}>
    {tiles.map((tile) => <div key={tile.key} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
      <div className="whitespace-nowrap">
        <div className="text-foreground-muted">{tile.label}</div>
        <div className="text-base font-medium text-foreground tabular-nums">{tile.value}</div>
        <div className="text-foreground-muted tabular-nums">{t('resourceMonitor.peak', { value: tile.key === 'cpu' ? cpuText(peak.cpu) : memoryText(peak.memory) })}</div>
      </div>
      {history?.points.length ? chart(tile.key, 48) : <span className="text-foreground-muted">{t('resourceMonitor.empty')}</span>}
    </div>)}
  </section>;

  const tableHeader = selected
    ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-live-soft px-3 py-2" role="status">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('resourceMonitor.snapshotAt', { time: new Date(selected.timestamp).toLocaleString() })}</div>
        <div className="text-foreground-muted">{sampleContext(selected, t)}</div>
        {selected.context?.unavailable && <div className="text-foreground-muted">{selected.context.unavailable}</div>}
      </div>
      <Button size="sm" variant="primary" onClick={() => setSelected(null)}>{t(live ? 'resourceMonitor.backToLive' : 'resourceMonitor.closeSnapshot')}</Button>
    </div>
    : <h3 className="text-sm font-medium">{t('resourceMonitor.liveProcesses')}</h3>;

  return <section className="space-y-5 text-xs" aria-label={t('resourceMonitor.timeline')}>
    <div className="grid grid-cols-2 gap-3">
      {tiles.map((tile) => <div key={tile.key} className="space-y-1 rounded-md border border-border px-3 py-3">
        <div className="text-foreground-muted">{tile.label}</div>
        <div className="text-lg font-medium text-foreground tabular-nums">{tile.value}</div>
        <div className="text-foreground-muted tabular-nums">{tile.note}</div>
      </div>)}
    </div>
    <div className="space-y-3">
      <div className="gg-resource-toolbar">
        <div className="gg-resource-range"><SegmentedTabs items={ranges} value={range} onChange={setRange} ariaLabel={t('resourceMonitor.range')} /></div>
        <div className="gg-resource-actions">
        {onFloat && <Button size="sm" variant="ghost" onClick={onFloat}>{t('resourceMonitor.float')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => void action('export')}>{t('resourceMonitor.export')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void action('clear')}>{t('resourceMonitor.clear')}</Button>
        </div>
      </div>
      {history?.points.length ? (['cpu', 'memory'] as const).map((metric) => <div key={metric} className="space-y-1">
        <div className="text-foreground-muted">{tiles.find((tile) => tile.key === metric)?.label}</div>
        {chart(metric, 96)}
      </div>) : <p className="text-foreground-muted">{t('resourceMonitor.empty')}</p>}
      <p className="text-foreground-muted">{t('resourceMonitor.stored', { count: history?.count ?? 0, bytes: formatBytes(history?.bytes ?? 0), time: last ? new Date(last.timestamp).toLocaleTimeString() : '–' })} {t('resourceMonitor.retention')}</p>
    </div>
    {(error || snapshot?.recordingError) && <p role="alert">{error || t('resourceMonitor.writeFailed')} <Button size="sm" variant="ghost" onClick={() => setRevision((n) => n + 1)}>{t('resourceMonitor.retry')}</Button></p>}
    {selected || live
      ? <ResourceMonitorView snapshot={selected ?? snapshot} live={!selected} header={tableHeader} />
      : history?.points.length ? <p className="text-foreground-muted">{t('resourceMonitor.pickHint')}</p> : null}
  </section>;
});

function sampleContext(sample: ResourceSnapshot, t: ReturnType<typeof useSessionMessages>['translate']): string {
  const tasks = sample.context?.localTasks;
  const windows = sample.context?.windows ?? [];
  const state = (w: (typeof windows)[number]) => t(!w.visible ? 'resourceMonitor.hidden' : w.minimized ? 'resourceMonitor.minimized' : 'resourceMonitor.visible');
  const titles = windows.map((w) => `${w.title} (${state(w)})`).join(' / ') || '–';
  const focused = windows.filter((w) => w.focused).map((w) => w.title).join(' / ') || '–';
  return `${t('resourceMonitor.context')}: ${titles} · ${t('resourceMonitor.foreground')}: ${focused} · ${t('resourceMonitor.localTasks')} ${tasks?.total ?? '–'} (${t('resourceMonitor.running')} ${tasks?.running ?? '–'} · ${t('resourceMonitor.waiting')} ${tasks?.waiting ?? '–'} · ${t('resourceMonitor.scheduled')} ${tasks?.scheduled ?? '–'})`;
}

type ChartData = { id: string; values: (ResourcePoint & { mem?: number; series: string })[] }[];
type DimensionClick = { dimensionInfo?: { data: { datum: { id?: number }[] }[] }[] };

/** Both charts plot this one dataset, so their time axes share the same extent. */
function timelineData(points: ResourcePoint[]): ChartData {
  let segment = 0;
  return [{ id: 'history', values: points.map((p, i) => {
    if (i && (p.runId !== points[i - 1].runId || p.timestamp - points[i - 1].timestamp > 30_000)) segment++;
    return { ...p, mem: p.memory === undefined ? undefined : p.memory / 1048576, series: String(segment) };
  }) }];
}

const peakOf = (points: ResourcePoint[] | undefined, key: 'cpu' | 'memory') => {
  const values = (points ?? []).flatMap((p) => p[key] ?? []);
  return values.length ? Math.max(...values) : undefined;
};
const cpuText = (cpu: number | undefined) => (cpu === undefined ? '–' : `${cpu.toFixed(1)}%`);
const memoryText = (memory: number | undefined) => (memory === undefined ? '–' : formatBytes(memory));
// Memory ticks switch to GB at the same 1024 MB boundary as formatBytes, so an axis and the readout beside it agree.
const axisLabel = (metric: 'cpu' | 'memory', v: number) => (metric === 'cpu' ? `${Math.round(v)}%` : v >= 1024 ? `${Number((v / 1024).toFixed(1))} GB` : `${Math.round(v)} MB`);
// A fixed label column keeps the two plot areas the same width, so one time lines up across both charts.
const AXIS_WIDTH = 68;

function TimelineChart({ data, metric, compact, select, labels }: { data: ChartData; metric: 'cpu' | 'memory'; compact: boolean; select: (id: number) => void; labels: { cpu: string; memory: string } }) {
  const theme = useChartTheme();
  const stroke = tokenColor('--live');
  // VChart can update data without rebuilding axes/layout; keep its spec stable between samples.
  const spec = useMemo(() => ({ type: 'line', theme, animation: false, background: 'transparent', padding: compact ? 2 : { top: 8, right: 8, bottom: 0, left: 0 },
    xField: 'timestamp', yField: metric === 'cpu' ? 'cpu' : 'mem', seriesField: 'series', invalidType: 'link',
    axes: [
      // nice: false — the axis ends at the last sample, so the newest point sits at the right edge.
      { orient: 'bottom', visible: !compact, type: 'time', nice: false, grid: { visible: false }, layers: [{ timeFormat: '%H:%M:%S' }] },
      { orient: 'left', visible: !compact, zero: true, width: AXIS_WIDTH, tick: { tickCount: 3 }, label: { formatMethod: (v: number | string) => axisLabel(metric, Number(v)) } },
    ],
    line: { style: { stroke, lineWidth: compact ? 1.5 : 2 } }, point: { visible: false }, legends: { visible: false },
    crosshair: { xField: { visible: !compact, line: { type: 'line', style: { lineWidth: 1 } } } },
    tooltip: { visible: !compact, mark: { visible: false }, dimension: {
      title: { value: (d: ResourcePoint) => new Date(d.timestamp).toLocaleTimeString() },
      content: [{ key: labels.cpu, value: (d: ResourcePoint) => cpuText(d.cpu) }, { key: labels.memory, value: (d: ResourcePoint) => memoryText(d.memory) }],
    } },
  }), [theme, stroke, compact, metric, labels.cpu, labels.memory]);
  const onDimensionClick = (event: DimensionClick) => {
    const id = event.dimensionInfo?.[0]?.data.flatMap((d) => d.datum).find((d) => d.id)?.id;
    if (id) select(id);
  };
  return <Suspense><VChart spec={spec as never} data={data} options={CHART_OPTIONS} onDimensionClick={onDimensionClick} /></Suspense>;
}
