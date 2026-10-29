/**
 * 最右上角那一块的页签条要给窗口按钮(Linux 自绘的最小化 / 最大化 / 关闭)留位置。原来留的是右端那一排自己的内边距,
 * 那一排不让位,窄了连同内边距一起被顶出条外 —— 10-28 实测:窗口 800、两块并排,最右那块 247px,
 * 「关闭这一块」压在最小化上 18px。
 *
 * 判据:留白是一格独立的位置,宽度读 `--titlebar-controls-width`(不写死 138 / 146),贴条的右端;
 * 右端那一排在剩下的地方排,任何宽度下都不伸进留白;放不下时「在 X 中打开」那半颗收起,「其他打开方式」与关闭还在;
 * 宽回来再放出来。真 Chromium、真 CSS、真页签条(TabStripShell + TabBarActionRow);「在 X 中打开」照 OpenInMenu 的形状搭。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { MessageSquare } from '@/lib/icons';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';

const CONTROLS = 138;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  document.documentElement.style.setProperty('--titlebar-controls-width', `${CONTROLS}px`);
});
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.documentElement.style.removeProperty('--titlebar-controls-width');
});

function SessionBlockActions() {
  return (
    <TabBarActionRow atWindowEdge>
      <div style={{ display: 'flex', alignItems: 'center', height: 28 }}>
        <button data-open-in-primary="" aria-label="在文件中打开" style={{ width: 28, height: 28 }} />
        <button aria-label="其他打开方式" style={{ width: 28, height: 28 }} />
      </div>
      <button aria-label="关闭这一块" style={{ width: 24, height: 24 }} />
    </TabBarActionRow>
  );
}

const frames = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame); };

async function mount(width: number) {
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <TabStripShell trailingSlot={<button style={{ width: 28, height: 28 }}>+</button>} actionsSlot={<SessionBlockActions />}>
      <TabSlot>
        <TabChip isActive label="Reply ok one" preSlot={<MessageSquare className="size-3" />} closeLabel="关闭" onClose={() => undefined} data-tabid="s" />
      </TabSlot>
    </TabStripShell>
  );
  await until('strip rendered', () => host!.querySelector('[data-tabid="s"]') !== null);
  await frames();
}

async function resize(width: number) {
  host!.style.width = `${width}px`;
  await frames();
}

function measure() {
  const bar = host!.querySelector<HTMLElement>('.session-tab-bar')!.getBoundingClientRect();
  const reserve = host!.querySelector<HTMLElement>('[data-window-controls-reserve]')!.getBoundingClientRect();
  const shown = (label: string) => {
    const el = host!.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
    return el.getBoundingClientRect().width > 0 ? el.getBoundingClientRect() : null;
  };
  return { bar, reserve, primary: shown('在文件中打开'), more: shown('其他打开方式'), close: shown('关闭这一块') };
}

for (const width of [220, 247, 272, 300]) {
  it(`a ${width}px block at the window edge: nothing reaches into the controls' place`, async () => {
    await mount(width);
    const { bar, reserve, more, close } = measure();
    expect(reserve.width, 'the reserve is the controls width').toBeCloseTo(CONTROLS, 0);
    expect(reserve.right, 'the reserve sits at the strip end').toBeCloseTo(bar.right, 0);
    expect(more!.right).toBeLessThanOrEqual(reserve.left);
    expect(close!.width, 'close keeps its size').toBeCloseTo(24, 0);
    expect(close!.right, 'close stays out of the controls').toBeLessThanOrEqual(reserve.left);
  });
}

it('247px (the 800px window, two blocks): the row does not fit whole, so Open in folds and Other ways / close stay', async () => {
  await mount(247);
  const { primary, more, close } = measure();
  expect(primary).toBeNull();
  expect(more).not.toBeNull();
  expect(close).not.toBeNull();
});

it('a wide block keeps Open in; narrowing folds it, widening brings it back', async () => {
  await mount(600);
  expect(measure().primary, 'wide: Open in shown').not.toBeNull();
  expect(measure().close!.right).toBeLessThanOrEqual(measure().reserve.left);
  await resize(247);
  expect(measure().primary, 'narrow: folded').toBeNull();
  expect(measure().close!.right).toBeLessThanOrEqual(measure().reserve.left);
  await resize(600);
  expect(measure().primary, 'wide again: back').not.toBeNull();
});

it('the reserve follows the variable: none where the controls do not sit on the content (mac / Windows title row)', async () => {
  document.documentElement.style.setProperty('--titlebar-controls-width', '0px');
  await mount(247);
  const { bar, reserve, close } = measure();
  expect(reserve.width).toBe(0);
  expect(close!.right).toBeLessThanOrEqual(bar.right);
});
