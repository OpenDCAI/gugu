// @vitest-environment jsdom
import { act } from 'react';
import { CartesianTimeAxis } from '@visactor/vchart/cjs/component/axis/cartesian/time-axis';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResourcePoint, ResourceSnapshot } from '@shared/resource-monitor';
import { createReactHarness, deferred } from '../../../../../../../../tests/support/testHarness';
import { ResourceTimeline } from './resource-timeline';

type ChartProps = {
  spec: { theme: string; yField: string; point: { visible: boolean }; tooltip: { visible: boolean }; axes: { orient: string }[]; data?: unknown };
  data?: { id: string; values: { id: number; mem?: number; series: string }[] }[];
  options: unknown;
  onDimensionClick: (event: { dimensionInfo: { data: { datum: { id: number }[] }[] }[] }) => void;
};
const rig = vi.hoisted(() => ({ charts: [] as ChartProps[], history: vi.fn(), point: vi.fn(), snapshot: null as ResourceSnapshot | null }));
vi.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }));
vi.mock('@visactor/react-vchart', () => ({ VChart: (props: ChartProps) => { rig.charts.push(props); return <div />; } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { resourceMonitor: { get snapshot() { return rig.snapshot; } } } }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { resourceMonitor: { history: rig.history, point: rig.point } } }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

const snapshot = (timestamp: number): ResourceSnapshot => ({ timestamp, cpuCount: 4, totalMemoryBytes: 1024, app: {}, appProcesses: [], entries: [] });
const history = (points: ResourcePoint[]) => ({ success: true, data: { points, count: points.length, bytes: 100 } });
const points: ResourcePoint[] = [
  { id: 1, timestamp: 1000, cpu: 1, memory: 1048576, runId: 'first' },
  { id: 2, timestamp: 2000, cpu: 2, memory: 2097152, runId: 'first' },
];
const cpu = () => rig.charts.filter((p) => p.spec.yField === 'cpu').at(-1)!;
const memory = () => rig.charts.filter((p) => p.spec.yField === 'mem').at(-1)!;
const clickAt = (id: number) => cpu().onDimensionClick({ dimensionInfo: [{ data: [{ datum: [{ id }] }] }] });
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  vi.clearAllMocks(); rig.charts.length = 0; rig.snapshot = snapshot(1);
  document.documentElement.dataset.theme = 'light';
  rig.history.mockResolvedValue(history(points)); rig.point.mockResolvedValue({ success: true, data: snapshot(2000) });
  harness = createReactHarness();
});
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme; });
const render = async (compact = false) => { await harness.render(<ResourceTimeline compact={compact} />); await act(async () => { await vi.dynamicImportSettled(); }); };

it.each([false, true])('buckets history refreshes without dropping chart data (compact=%s)', async (compact) => {
  await render(compact);
  const before = cpu();
  expect(rig.history).toHaveBeenCalledTimes(1);
  for (const timestamp of [1501, 3001, 4999]) {
    rig.snapshot = snapshot(timestamp);
    await render(compact);
    expect(rig.history).toHaveBeenCalledTimes(1);
    expect(cpu().data).toBe(before.data);
  }
  rig.history.mockResolvedValueOnce(history([...points, { ...points[1], id: 3, timestamp: 5000 }]));
  rig.snapshot = snapshot(5000);
  await render(compact);
  expect(rig.history).toHaveBeenCalledTimes(2);
  expect(cpu().spec).toBe(before.spec);
  expect(cpu().data?.[0].values.map((p) => p.id)).toEqual([1, 2, 3]);
  rig.snapshot = snapshot(6500);
  await render(compact);
  expect(rig.history).toHaveBeenCalledTimes(2);
});

it('keeps chart configuration and data unchanged while awaiting history, then updates only data', async () => {
  await render();
  const before = cpu();
  const pending = deferred<ReturnType<typeof history>>();
  rig.history.mockReturnValueOnce(pending.promise); rig.snapshot = snapshot(5000);
  await render();
  expect(cpu().spec).toBe(before.spec);
  expect(cpu().data).toBe(before.data);
  expect(cpu().options).toBe(before.options);
  await act(async () => { pending.resolve(history([...points, { ...points[1], id: 3, timestamp: 3000 }])); });
  expect(cpu().spec).toBe(before.spec);
  expect(cpu().data).not.toBe(before.data);
  expect(cpu().data?.[0].values.map((p) => p.id)).toEqual([1, 2, 3]);
  expect(cpu().spec.data).toBeUndefined();
});

it('preserves sample selection, unit conversion, and run boundaries without refreshing charts on selection', async () => {
  rig.history.mockResolvedValue(history([...points, { ...points[1], id: 3, timestamp: 3000, runId: 'second' }]));
  await render();
  expect(memory().data?.[0].values.map((p) => p.mem)).toEqual([1, 2, 2]);
  expect(memory().data).toBe(cpu().data);
  expect(cpu().data?.[0].values.map((p) => p.series)).toEqual(['0', '0', '1']);
  const before = cpu();
  await act(async () => { clickAt(2); });
  expect(rig.point).toHaveBeenCalledWith(2);
  expect(harness.container.querySelector('table')).not.toBeNull();
  expect(harness.container.querySelectorAll('select')).toHaveLength(1);
  expect(cpu().spec).toBe(before.spec);
  expect(cpu().data).toBe(before.data);
});

it('updates chart styling when the theme changes while retaining the dataset', async () => {
  await render();
  const before = cpu();
  await act(async () => { document.documentElement.dataset.theme = 'dark'; await Promise.resolve(); });
  expect(cpu().spec.theme).toBe('dark');
  expect(cpu().spec).not.toBe(before.spec);
  expect(cpu().data).toBe(before.data);
});

it('draws lines without point marks, hides hover readouts only in compact mode, and keeps full-page selection', async () => {
  await render();
  const values = [cpu().data, memory().data];
  expect([cpu().spec.point.visible, memory().spec.point.visible]).toEqual([false, false]);
  expect([cpu().spec.tooltip.visible, memory().spec.tooltip.visible]).toEqual([true, true]);
  await harness.render(<ResourceTimeline compact />);
  expect([cpu().spec.tooltip.visible, memory().spec.tooltip.visible]).toEqual([false, false]);
  expect([cpu().data, memory().data]).toEqual(values);
  await render();
  expect(cpu().spec.tooltip.visible).toBe(true);
  await act(async () => { clickAt(2); });
  expect(rig.point).toHaveBeenCalledWith(2);
  expect(harness.container.querySelector('table')).not.toBeNull();
  expect(harness.container.querySelectorAll('select')).toHaveLength(1);
});

it('shows distinct clock labels for samples on the same day through the real time-axis formatter', async () => {
  const timestamps = [new Date(2026, 9, 22, 15, 0, 0).getTime(), new Date(2026, 9, 22, 15, 0, 5).getTime()];
  rig.history.mockResolvedValue(history(points.map((point, i) => ({ ...point, timestamp: timestamps[i] }))));
  await render();
  type AxisFormatter = (this: { _spec: unknown }) => (value: number, datum: object, index: number, data: unknown[], layer: number) => string;
  const getLabelFormat = Reflect.get(CartesianTimeAxis.prototype, '_getLabelFormatMethod') as AxisFormatter;
  for (const chart of [cpu(), memory()]) {
    const format = getLabelFormat.call({ _spec: chart.spec.axes.find((axis) => axis.orient === 'bottom') });
    expect(timestamps.map((value, i) => format(value, {}, i, [], 0))).toEqual(['15:00:00', '15:00:05']);
  }
});
