import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { formatBytes } from '@renderer/utils/formatBytes';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ResourceHistory, ResourcePoint, ResourceSnapshot } from '@shared/resource-monitor';
import { rendererLogger } from '@/lib/log';
import { useChartTheme } from '@/components/usage/useChartTheme';
const log = rendererLogger('resource-monitor/timeline');
const VChart = lazy(() => import('@visactor/react-vchart').then((m) => ({ default: m.VChart })));
const CHART_OPTIONS = { mode: 'desktop-browser' as const };

export const ResourceTimeline = observer(function ResourceTimeline({ compact = false }: { compact?: boolean }) {
  const { translate: t } = useSessionMessages();
  const snapshot = appState.resourceMonitor.snapshot;
  const [history, setHistory] = useState<ResourceHistory | null>(null);
  const [selected, setSelected] = useState<ResourceSnapshot | null>(null);
  const [range, setRange] = useState(0);
  const live = snapshot ? Math.floor(snapshot.timestamp / 5000) : null;
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const last = history?.points.at(-1);
  const fail = (e: unknown) => { log.warn({ error: String(e) }, 'resource history request failed'); setError(t('resourceMonitor.historyFailed')); };
  useEffect(() => {
    let active = true;
    const until = Date.now();
    void rpc.resourceMonitor.history(range ? until - range : 0, until).then((res) => {
      if (active && res.success) { setHistory(res.data); setError(''); }
    }).catch((e: unknown) => { if (active) fail(e); });
    return () => { active = false; };
  }, [live, range, revision]);
  const action = async (kind: 'export' | 'clear') => {
    try {
      if (kind === 'export') await rpc.resourceMonitor.exportHistory(t('resourceMonitor.export'));
      else { await rpc.resourceMonitor.clearHistory(); setHistory(null); setSelected(null); const res = await rpc.resourceMonitor.history(); if (res.success) setHistory(res.data); }
    } catch (e) { fail(e); }
  };
  const select = (id: number) => { void rpc.resourceMonitor.point(id).then((res) => {
    if (res.success) { setSelected(res.data); if (!res.data) setError(t('resourceMonitor.expired')); }
  }).catch(fail); };
  return <section className="my-2 space-y-2 text-xs" aria-label={t('resourceMonitor.timeline')}>
    {!compact && <div className="flex flex-wrap items-center gap-2">
      <strong>{t('resourceMonitor.timeline')}</strong>
      <select aria-label={t('resourceMonitor.range')} value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded border border-foreground/10 bg-background p-1">
        {[0, 900_000, 3_600_000].map((v) => <option key={v} value={v}>{v ? `${v / 60_000} min` : t('resourceMonitor.all')}</option>)}
      </select>
      <button type="button" onClick={() => void action('export')}>{t('resourceMonitor.export')}</button>
      <button type="button" onClick={() => void action('clear')}>{t('resourceMonitor.clear')}</button>
    </div>}
    <div>{t('resourceMonitor.cpuOneCore')} · {last?.cpu === undefined ? '–' : `${last.cpu.toFixed(1)}%`} · {t('resourceMonitor.memoryRss')} · {last?.memory === undefined ? '–' : formatBytes(last.memory)} {last && <time>{new Date(last.timestamp).toLocaleTimeString()}</time>}</div>
    {history?.points.length ? <>
      {(['cpu', 'memory'] as const).map((metric) => <div key={metric} aria-label={metric === 'cpu' ? t('resourceMonitor.cpuOneCore') : t('resourceMonitor.memoryRss')} style={{ height: compact ? 32 : 120 }}><TimelineChart points={history.points} metric={metric} compact={compact} select={select} /></div>)}
    </> : <p>{t('resourceMonitor.empty')}</p>}
    {compact ? <p>{t('resourceMonitor.running')}: {snapshot?.context?.localTasks?.running ?? '–'}</p> : <>
      <p className="text-foreground-muted">{t('resourceMonitor.retention')} · {history?.count ?? 0} · {formatBytes(history?.bytes ?? 0)}</p>
      {selected && <div className="space-y-1 rounded border border-foreground/10 p-2">
        <strong>{new Date(selected.timestamp).toLocaleString()}</strong>
        <p>{t('resourceMonitor.context')}: {selected.context?.windows.map((w) => w.title).join(' / ') || '–'}</p>
        <p>{t('resourceMonitor.localTasks')}: {selected.context?.localTasks?.total ?? '–'} · PTY: {selected.entries.length}</p>
        <p>{t('resourceMonitor.running')}: {selected.context?.localTasks?.running ?? '–'} · {t('resourceMonitor.waiting')}: {selected.context?.localTasks?.waiting ?? '–'} · {t('resourceMonitor.scheduled')}: {selected.context?.localTasks?.scheduled ?? '–'}</p>
        <p>{t('resourceMonitor.foreground')}: {selected.context?.windows.filter((w) => w.focused).map((w) => w.id).join(', ') || '–'}</p>
        <p>{selected.context?.windows.map((w) => `#${w.id}: ${w.visible ? t('resourceMonitor.visible') : t('resourceMonitor.hidden')} / ${w.minimized ? t('resourceMonitor.minimized') : '–'}`).join(' · ')}</p>
        <table className="w-full text-left tabular-nums"><tbody>{selected.appProcesses.map((p) => <tr key={p.pid}><td>{p.type} · {p.pid}</td><td>{p.cpu?.toFixed(2) ?? '–'}%</td><td>{formatBytes(p.memory)}</td></tr>)}{selected.entries.map((p) => <tr key={p.ptySessionId}><td>{p.title ?? p.leafId} · {p.pid ?? '–'}</td><td>{p.cpu.toFixed(2)}%</td><td>{formatBytes(p.memory)}</td></tr>)}</tbody></table>
        {selected.context?.unavailable && <p role="status">{selected.context.unavailable}</p>}
      </div>}
    </>}
    {(error || snapshot?.recordingError) && <p role="alert">{error || t('resourceMonitor.writeFailed')} <button type="button" onClick={() => setRevision((n) => n + 1)}>{t('resourceMonitor.retry')}</button></p>}
  </section>;
});

function TimelineChart({ points, metric, compact, select }: { points: ResourcePoint[]; metric: 'cpu' | 'memory'; compact: boolean; select: (id: number) => void }) {
  const theme = useChartTheme();
  const data = useMemo(() => {
    let segment = 0;
    return [{ id: 'history', values: points.flatMap((p, i) => {
      if (i && (p.runId !== points[i - 1].runId || p.timestamp - points[i - 1].timestamp > 30_000)) segment++;
      const value = p[metric];
      return value == null ? [] : [{ ...p, value: metric === 'memory' ? value / 1048576 : value, series: String(segment) }];
    }) }];
  }, [points, metric]);
  // VChart can update data without rebuilding axes/layout; keep its spec stable between samples.
  const spec = useMemo(() => ({ type: 'line', theme, animation: false, background: 'transparent', padding: 5,
    xField: 'timestamp', yField: 'value', seriesField: 'series',
    axes: [{ orient: 'bottom', visible: !compact, type: 'time', label: { formatMethod: (v: number) => new Date(Number(v)).toLocaleTimeString() } }, { orient: 'left', visible: !compact, zero: true }],
    line: { style: { stroke: metric === 'cpu' ? '#1664ff' : '#3cc780' } }, point: { visible: !compact, style: { size: 3 } }, legends: { visible: false },
  }), [theme, compact, metric]);
  return <Suspense><VChart spec={spec as never} data={data} options={CHART_OPTIONS} onClick={(event: { datum?: { id?: number } }) => { if (event.datum?.id) select(event.datum.id); }} /></Suspense>;
}
