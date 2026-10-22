// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResourcePoint, ResourceSnapshot } from '@shared/resource-monitor';
import { createReactHarness, deferred } from '../../../../../../../../tests/support/testHarness';
import { ResourceTimeline } from './resource-timeline';

type ChartProps = {
  spec: { theme: string; line: { style: { stroke: string } }; point: { visible: boolean }; data?: unknown };
  data?: { id: string; values: { id: number; value: number; series: string }[] }[];
  options: unknown;
  onClick: (event: { datum: { id: number } }) => void;
};
const rig = vi.hoisted(() => ({ charts: [] as ChartProps[], history: vi.fn(), point: vi.fn(), snapshot: null as ResourceSnapshot | null }));
vi.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }));
vi.mock('@visactor/react-vchart', () => ({ VChart: (props: ChartProps) => { rig.charts.push(props); return <div />; } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { resourceMonitor: { get snapshot() { return rig.snapshot; } } } }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { resourceMonitor: { history: rig.history, point: rig.point } } }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

const snapshot = (timestamp: number): ResourceSnapshot => ({ timestamp, cpuCount: 4, totalMemoryBytes: 1024, app: {}, appProcesses: [], entries: [] });
const history = (points: ResourcePoint[]) => ({ success: true, data: { points, count: points.length, bytes: 100, discarded: 0 } });
const points: ResourcePoint[] = [
  { id: 1, timestamp: 1000, cpu: 1, memory: 1048576, runId: 'first' },
  { id: 2, timestamp: 2000, cpu: 2, memory: 2097152, runId: 'first' },
];
const cpu = () => rig.charts.filter((p) => p.spec.line.style.stroke === '#1664ff').at(-1)!;
const memory = () => rig.charts.filter((p) => p.spec.line.style.stroke === '#3cc780').at(-1)!;
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  vi.clearAllMocks(); rig.charts.length = 0; rig.snapshot = snapshot(1);
  document.documentElement.dataset.theme = 'light';
  rig.history.mockResolvedValue(history(points)); rig.point.mockResolvedValue({ success: true, data: snapshot(2000) });
  harness = createReactHarness();
});
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme; });
const render = async () => { await harness.render(<ResourceTimeline />); await act(async () => { await vi.dynamicImportSettled(); }); };

it('keeps chart configuration and data unchanged while awaiting history, then updates only data', async () => {
  await render();
  const before = cpu();
  const pending = deferred<ReturnType<typeof history>>();
  rig.history.mockReturnValueOnce(pending.promise); rig.snapshot = snapshot(2);
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
  expect(memory().data?.[0].values.map((p) => p.value)).toEqual([1, 2, 2]);
  expect(cpu().data?.[0].values.map((p) => p.series)).toEqual(['0', '0', '1']);
  const before = cpu();
  await act(async () => { before.onClick({ datum: { id: 2 } }); });
  expect(rig.point).toHaveBeenCalledWith(2);
  expect(harness.container.querySelector('table')).not.toBeNull();
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

it('omits compact point marks while keeping full-page point selection and both datasets', async () => {
  await render();
  const values = [cpu().data, memory().data];
  expect(cpu().spec.point.visible).toBe(true);
  expect(memory().spec.point.visible).toBe(true);
  await harness.render(<ResourceTimeline compact />);
  expect(cpu().spec.point.visible).toBe(false);
  expect(memory().spec.point.visible).toBe(false);
  expect([cpu().data, memory().data]).toEqual(values);
  await render();
  expect(cpu().spec.point.visible).toBe(true);
  expect(memory().spec.point.visible).toBe(true);
  await act(async () => { cpu().onClick({ datum: { id: 2 } }); });
  expect(rig.point).toHaveBeenCalledWith(2);
  expect(harness.container.querySelector('table')).not.toBeNull();
});
