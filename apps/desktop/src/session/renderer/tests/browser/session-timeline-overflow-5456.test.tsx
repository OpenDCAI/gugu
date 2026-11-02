/**
 * minimap 在超长会话下的疏密与框内框外 —— 真 Chromium、真 CSS、真组件。
 *
 * owner 2026-09-10 实机截图:一条 260 轮的会话,刻度从顶栏一直漫到窗口下沿。
 * 旧几何是「一轮一格 + 从中点往两头长」,轨长 = 轮数 × 12,260 轮 = 3120px,
 * 而聊天栏只有 ~860px:框内只画得下中间 71 条,会话的头尾**点不到**。
 * 第一版按「行距压细」改(一行 3.3px),owner 看完:「要不弄个上限吧,现在太密了」——
 * 于是行高钉死 12px,格数以轨道站得下的为上限,一格代表多轮。
 *
 * 疏密与框内框外都是布局属性:格数的算术在 node 里判得了、**画出来什么样判不了**
 * (justify-center、绝对定位的 inset-y-0、flex 的兜底挤压都只有真引擎说得清)。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionTimelineRail } from '@renderer/features/sessions/view/session-timeline-rail';
import type { TimelineTurn } from '@renderer/features/sessions/view/session-timeline-turns';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@renderer/index.css';

/** owner 报这个 bug 时的窗口:1280×900,减掉 40px 顶栏 = 聊天栏这一列的高度。 */
const COLUMN_HEIGHT = 860;

let root: Root;
let host: HTMLDivElement;
/** 产品里那一列:`relative min-h-0 flex-1 pl-6`(session-chat-column) —— 轨就绝对定位在它里面。 */
let column: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  // ⚠️ 主题变量挂在 emlight/emdark 上(lib/theme/host-theme.ts),少了它刻度的
  // bg-foreground-muted 算出来是透明 —— 颜色那条断言会变成「两个透明相等」。
  host.className = 'gugu-skin emlight';
  column = document.createElement('div');
  column.className = 'relative pl-6';
  column.style.height = `${COLUMN_HEIGHT}px`;
  column.style.width = '600px';
  host.append(column);
  document.body.append(host);
  root = createRoot(column);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

const turns = (count: number): TimelineTurn[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    anchorItemId: `u${i}`,
    itemIds: [`u${i}`],
    prompt: `第 ${i + 1} 轮`,
    reply: '回复',
  }));

/**
 * 挂上去 + 等几何**稳定**。⚠️ 不能只等两帧:轨高是 ResizeObserver 量出来的,量到之后
 * React 还要带着 2000 张预览卡重渲一遍,慢于两帧(实测那一刻量到的是首帧的 flex 挤压态)。
 */
async function render(count: number | TimelineTurn[], currentTurnId?: string): Promise<HTMLElement[]> {
  const list = typeof count === 'number' ? turns(count) : count;
  root.render(
    <SessionLocalizationProvider>
      <SessionTimelineRail turns={list} currentTurnId={currentTurnId ?? `t${list.length - 1}`} onJump={() => {}} />
    </SessionLocalizationProvider>
  );
  let last = '';
  let stable = 0;
  for (let frame = 0; frame < 240 && stable < 3; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const first = column.querySelector<HTMLElement>('[data-tick-index]');
    const height = first?.style.height ?? '';
    stable = height && height === last ? stable + 1 : 0;
    last = height;
  }
  return [...column.querySelectorAll<HTMLElement>('[data-tick-index]')];
}

const spread = (ticks: HTMLElement[]) => {
  const rects = ticks.map((tick) => tick.getBoundingClientRect());
  return {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
};

describe('minimap 长会话几何 (#4874)', () => {
  it('260 轮:格子数封在轨道站得下的 71 个以内,整条轨都在这一列里面', async () => {
    const ticks = await render(260);
    expect(ticks.length).toBeLessThanOrEqual(Math.floor(COLUMN_HEIGHT / 12));
    expect(ticks).toHaveLength(65);
    const box = column.getBoundingClientRect();
    const { top, bottom } = spread(ticks);
    // 旧行为:3120px 的轨居中放进 860px 的框,上下各溢出 1130px。
    expect(bottom - top).toBeLessThanOrEqual(COLUMN_HEIGHT);
    expect(top).toBeGreaterThanOrEqual(box.top - 0.5);
    expect(bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    // 疏密不变:还是 12px 一格 —— ⚠️ 不是靠 flex 把超长的轨挤回来的(那样每格会被压到
    // 3px 上下,正是 owner 说「太密了」的那一版)。
    expect(ticks[0].getBoundingClientRect().height).toBeCloseTo(12, 1);
    // 每一轮都归属某一格:区间首尾相接,第一格从第 1 轮起,末一格到第 260 轮止。
    expect(ticks[0].dataset.tickSpan).toBe('1-4');
    expect(ticks[ticks.length - 1].dataset.tickSpan).toBe('257-260');
  });

  it('放得下就不压:20 轮还是 12px 一行、还是居中', async () => {
    const ticks = await render(20);
    expect(ticks[0].getBoundingClientRect().height).toBeCloseTo(12, 1);
    const box = column.getBoundingClientRect();
    const { top, bottom } = spread(ticks);
    expect(bottom - top).toBeCloseTo(240, 1);
    // 居中:上下留白一样多。
    expect(top - box.top).toBeCloseTo(box.bottom - bottom, 1);
  });

  it('2000 轮画出来和 260 轮一样疏 —— 上限在格数,不在行距', async () => {
    const ticks = await render(2000);
    const box = column.getBoundingClientRect();
    const { top, bottom } = spread(ticks);
    expect(ticks.length).toBeLessThanOrEqual(Math.floor(COLUMN_HEIGHT / 12));
    expect(bottom - top).toBeLessThanOrEqual(COLUMN_HEIGHT);
    expect(top).toBeGreaterThanOrEqual(box.top - 0.5);
    expect(ticks[0].getBoundingClientRect().height).toBeCloseTo(12, 1);
    const pill = ticks[0].querySelector<HTMLElement>('[data-slot="tick"]');
    expect(pill!.getBoundingClientRect().height).toBeCloseTo(2, 1);
    expect(ticks[ticks.length - 1].dataset.tickSpan?.endsWith('-2000')).toBe(true);
  });

  it('「你在这」落在覆盖它的那一格上,而且画得比旁边实', async () => {
    const long = await render(260);
    const current = long.filter((tick) => tick.dataset.tickCurrent === 'true');
    // 当前那一轮只能属于一格 —— 一格代表多轮之后这条最容易画重。
    expect(current).toHaveLength(1);
    // render() 里把最后一轮(第 260 轮)当作在读的那一轮。
    expect(current[0].dataset.tickSpan).toBe('257-260');
    const currentPill = current[0].querySelector<HTMLElement>('[data-slot="tick"]')!;
    const otherPill = long[0].querySelector<HTMLElement>('[data-slot="tick"]')!;
    expect(getComputedStyle(currentPill).backgroundColor).not.toBe(
      getComputedStyle(otherPill).backgroundColor
    );
  });

  it('轨自己不吃指针事件 —— 那条空白车道不许替 transcript 挡掉点击', async () => {
    await render(20);
    const rail = column.querySelector<HTMLElement>('[data-region="session-timeline"]')!;
    expect(getComputedStyle(rail).pointerEvents).toBe('none');
    const tick = column.querySelector<HTMLElement>('[data-tick-index]')!;
    expect(getComputedStyle(tick).pointerEvents).toBe('auto');
  });

  it('owner 10-28 方案 A:你的刻度满墨加长,投递短而淡,连续 3 条以上的投递合成更粗的一段', async () => {
    // m = 你说的;a/b = 两个来源投递进来的
    const list: TimelineTurn[] = [...'mamabmababam'].map((c, i) => ({
      id: `t${i}`, anchorItemId: `u${i}`, itemIds: [`u${i}`], prompt: `第 ${i + 1} 轮`, reply: '',
      ...(c === 'm' ? {} : { sender: { kind: 'session' as const, name: c === 'a' ? 'Codex 3' : 'Claude 2' } }),
    }));
    // 阅读线压在第 1 轮(你的),其余都不是「正在读」—— 颜色只比静止的。
    const ticks = await render(list, 't0');
    expect(ticks.map((t) => `${t.dataset.tickKind}:${t.dataset.tickSpan}`)).toEqual([
      'mine:1-1', 'delivery:2-2', 'mine:3-3', 'delivery:4-4', 'delivery:5-5', 'mine:6-6', 'run:7-11', 'mine:12-12',
    ]);
    const pill = (tick: HTMLElement) => tick.querySelector<HTMLElement>('[data-slot="tick"]')!.getBoundingClientRect();
    const ink = (tick: HTMLElement) => getComputedStyle(tick.querySelector<HTMLElement>('[data-slot="tick"]')!).backgroundColor;
    const [, delivery, mine, , , , run] = ticks;
    expect(pill(mine).width).toBeCloseTo(18, 0);
    expect(pill(delivery).width).toBeCloseTo(8, 0);
    expect(pill(run).width).toBeCloseTo(8, 0);
    expect(pill(mine).height).toBeCloseTo(2, 1);
    expect(pill(run).height).toBeCloseTo(4, 1);
    // 你的满墨,投递与合并段是别的(更淡的)墨;合并段比单条投递还淡。
    expect(ink(mine)).not.toBe(ink(delivery));
    expect(ink(run)).not.toBe(ink(delivery));
    // 正在读的那一格只换颜色,长度照旧(看得出是谁的)。
    const current = ticks.find((t) => t.dataset.tickCurrent === 'true')!;
    expect(current.dataset.tickKind).toBe('mine');
    expect(pill(current).width).toBeCloseTo(18, 0);
    expect(ink(current)).not.toBe(ink(mine));
  });
});
