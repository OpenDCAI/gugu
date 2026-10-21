/**
 * owner 10-07:顶层页左右拖时(比如从任务页滑到聊天页),「像微信那样……你一边滑,它就根据滑动的坐标实时变化底部的
 * 亮暗状态」,❌ 等完全滑过去高亮图标才变。分页器每一帧把连续位置写到 tab 栏上(TAB_POSITION_VAR),每格亮度
 * max(0, 1 - |位置 - 格号|),前景在 --text-tertiary 与 --text-primary 之间按亮度插值,头像格的环与透明度同理。
 * 真 Chromium、真 tokens.css、产品同一份样式(tabItemStyle / TAB_AVATAR_STYLE),读计算后的值。
 * (安卓 WebView 113 上的读数在车道证据里,这里跑的是 Playwright 的 Chromium。)
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { SIDEBAR_TABS } from '@gugu/core/shared/enums/sidebarTabModels';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { TAB_AVATAR_STYLE, TAB_POSITION_VAR, tabItemStyle } from '@/mobile/settledTab';
import '@/styles/tokens.css';

let root: Root | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

/** 计算后的颜色 → [r, g, b, a](0..1)。color-mix 的结果有的版本写成 `color(srgb r g b / a)`,有的写成 rgb()。 */
function channels(css: string): number[] {
  const srgb = css.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), srgb[4] === undefined ? 1 : Number(srgb[4])];
  const rgb = css.match(/^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`unparsed color: ${css}`);
}

/** 按产品的写法搭一条 tab 栏:变量挂在栏上(分页器写的地方),每格套 tabItemStyle,最后一格是头像格。 */
async function mountBar(position: number | null, activeIndex: number) {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  root.render(
    <nav data-bar ref={(nav) => { if (nav && position !== null) nav.style.setProperty(TAB_POSITION_VAR, String(position)); }}>
      {/* 两端的参照色也过一道 srgb 的 color-mix:token 是 oklch,直接读计算值拿到的是 oklch()。 */}
      <span data-ref="primary" style={{ color: 'color-mix(in srgb, var(--text-primary) 100%, var(--text-tertiary))' }} />
      <span data-ref="tertiary" style={{ color: 'color-mix(in srgb, var(--text-primary) 0%, var(--text-tertiary))' }} />
      {SIDEBAR_TABS.map((tab, index) => (
        <button key={tab} type="button" data-tab={index} style={tabItemStyle(index, activeIndex)}>
          <span data-avatar={index} style={index === SIDEBAR_TABS.length - 1 ? TAB_AVATAR_STYLE : undefined}>{tab}</span>
        </button>
      ))}
    </nav>,
  );
  // 等事实:整条栏提交上了(ref 回调与 DOM 同一次提交,变量也已写上)。❌ 只等一帧:冷启动时还没提交(复核 #6972 F2)。
  await until('the bar is drawn', () => document.querySelector(`[data-avatar="${SIDEBAR_TABS.length - 1}"]`) != null);
  const color = (selector: string) => channels(getComputedStyle(document.querySelector(selector)!).color);
  const primary = color('[data-ref="primary"]');
  const tertiary = color('[data-ref="tertiary"]');
  return {
    primary,
    tertiary,
    /** 第 i 格的颜色落在两色连线上的哪一点(0 = 暗色,1 = 亮色)。 */
    lit: (index: number) => {
      const c = color(`[data-tab="${index}"]`);
      const span = primary.map((p, k) => p - tertiary[k]!);
      const k = span.reduce((best, d, i) => (Math.abs(d) > Math.abs(span[best]!) ? i : best), 0);
      for (let ch = 0; ch < 3; ch += 1) {
        expect.soft(Math.abs(c[ch]! - (tertiary[ch]! + span[ch]! * ((c[k]! - tertiary[k]!) / span[k]!))), `tab ${index} lies on the line between the two colours`).toBeLessThan(0.01);
      }
      return (c[k]! - tertiary[k]!) / span[k]!;
    },
    avatar: () => {
      const el = document.querySelector<HTMLElement>(`[data-avatar="${SIDEBAR_TABS.length - 1}"]`)!;
      const style = getComputedStyle(el);
      return { opacity: Number(style.opacity), ringPx: Number(style.boxShadow.match(/ ([\d.]+)px$/)?.[1] ?? NaN) };
    },
  };
}

it('the two colours are different (positive control for every reading below)', async () => {
  const bar = await mountBar(null, 0);
  expect(Math.max(...bar.primary.slice(0, 3).map((p, i) => Math.abs(p - bar.tertiary[i]!)))).toBeGreaterThan(0.1);
});

for (const [position, expected] of [
  [0, [1, 0, 0, 0]],
  [0.25, [0.75, 0.25, 0, 0]],
  [0.5, [0.5, 0.5, 0, 0]],
  [0.75, [0.25, 0.75, 0, 0]],
  [1, [0, 1, 0, 0]],
  [2.6, [0, 0, 0.4, 0.6]],
] as const) {
  it(`dragged to ${position}: each tab is lit by its distance to the finger`, async () => {
    const bar = await mountBar(position, 0);
    expected.forEach((want, index) => expect.soft(bar.lit(index), `tab ${index}`).toBeCloseTo(want, 2));
  });
}

it('before the pager has written a position, the active tab is fully lit and the others dark', async () => {
  const bar = await mountBar(null, 2);
  [0, 0, 1, 0].forEach((want, index) => expect.soft(bar.lit(index), `tab ${index}`).toBeCloseTo(want, 2));
});

it('the avatar tab: its ring thickness and opacity follow the same lit value', async () => {
  const dark = (await mountBar(SIDEBAR_TABS.length - 2, 0)).avatar();
  expect.soft(dark.opacity).toBeCloseTo(0.72, 2);
  expect.soft(dark.ringPx, 'no ring on a dark tab').toBeCloseTo(0, 2);
  root?.unmount();
  document.body.replaceChildren();
  const half = (await mountBar(SIDEBAR_TABS.length - 1.5, 0)).avatar();
  expect.soft(half.opacity).toBeCloseTo(0.86, 2);
  expect.soft(half.ringPx).toBeCloseTo(0.75, 2);
  root?.unmount();
  document.body.replaceChildren();
  const lit = (await mountBar(SIDEBAR_TABS.length - 1, 0)).avatar();
  expect.soft(lit.opacity).toBeCloseTo(1, 2);
  expect.soft(lit.ringPx).toBeCloseTo(1.5, 2);
});
