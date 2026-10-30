import { keyframes, style } from '@vanilla-extract/css';

/** 与过程行的大脑图标同宽(17),点 4、点距 2。 */
export const gridLoader = style({
  display: 'inline-grid',
  gridTemplateColumns: 'repeat(3, 4px)',
  gap: 2,
  width: 17,
  justifyContent: 'center',
  flex: 'none',
});

/*
 * 3×3 点阵 —— 「在跑」的那个记号(owner 2026-10-27 原型):每次亮 3 个点,120ms 走一步,9 步一圈;亮 0.9、暗 0.15,
 * 透明度过渡 300ms(ease)。从前是 JS 每 120ms 切一次 class,由过渡去淡入淡出:一个在跑的任务就让主线程每步重算样式、
 * 整窗一直出帧,窗口不可见也照跑。现在整圈写成每个点自己的透明度关键帧,只在合成器上跑。
 *
 * 曲线不是重画的:下面按 CSS Transitions 的规则(含中途反向时的缩短系数)把「每 120ms 换一次目标 + 300ms ease 过渡」
 * 逐毫秒算一遍,取稳定后的一圈,每 10ms 一个关键帧 —— 与旧实现实测逐帧对齐(RMS 透明度差 0.013)。
 */
const FRAMES = ['045', '048', '348', '378', '237', '267', '126', '156', '015'];
const ON = 0.9;
const OFF = 0.15;
const STEP_MS = 120;
const FADE_MS = 300;
const SAMPLE_MS = 10;
const CYCLE_MS = STEP_MS * FRAMES.length;
const lit = (cell: number, frame: number) => FRAMES[frame % FRAMES.length]!.includes(String(cell));

/** CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1). */
function ease(x: number): number {
  const curve = (t: number, a: number, b: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (curve(mid, 0.25, 0.25) < x) lo = mid;
    else hi = mid;
  }
  return curve((lo + hi) / 2, 0.1, 1);
}

type Fade = { from: number; to: number; at: number; duration: number; reversingStart: number; factor: number };

/** One cell's opacity over a steady-state cycle, sampled every SAMPLE_MS. */
function cellCurve(cell: number): number[] {
  let value = lit(cell, 0) ? ON : OFF;
  let fade: Fade | null = null;
  const read = (t: number) => {
    if (!fade) return value;
    const progress = fade.duration > 0 ? Math.min(1, (t - fade.at) / fade.duration) : 1;
    const current = fade.from + (fade.to - fade.from) * ease(progress);
    if (progress >= 1) { value = fade.to; fade = null; }
    return current;
  };
  const target = (to: number, t: number) => {
    const current = read(t);
    if (!fade) {
      if (current !== to) fade = { from: current, to, at: t, duration: FADE_MS, reversingStart: current, factor: 1 };
      return;
    }
    if (fade.to === to) return;
    if (to === fade.reversingStart) {
      // Reversing a running transition shortens it (css-transitions-1, reversing shortening factor).
      const portion = ease(Math.min(1, (t - fade.at) / fade.duration));
      const factor = Math.abs(portion * fade.factor + (1 - fade.factor));
      fade = { from: current, to, at: t, duration: FADE_MS * factor, reversingStart: fade.to, factor };
    } else {
      fade = { from: current, to, at: t, duration: FADE_MS, reversingStart: current, factor: 1 };
    }
  };
  const warmUp = CYCLE_MS * 10;
  const samples: number[] = [];
  for (let t = 0; t <= warmUp + CYCLE_MS; t += 1) {
    if (t % STEP_MS === 0) target(lit(cell, t / STEP_MS) ? ON : OFF, t);
    const current = read(t);
    if (t >= warmUp && (t - warmUp) % SAMPLE_MS === 0) samples.push(Math.round(current * 1000) / 1000);
  }
  return samples;
}

export const gridLoaderCells = Array.from({ length: 9 }, (_, cell) => {
  const curve = cellCurve(cell);
  const frames = keyframes(Object.fromEntries(curve.map((opacity, i) => [`${((i * 100) / (curve.length - 1)).toFixed(3)}%`, { opacity }])));
  return style({
    width: 4,
    height: 4,
    borderRadius: 9999,
    background: 'currentColor',
    // 减少动态效果时就停在第一帧的图案(旧实现同样不走)。
    opacity: lit(cell, 0) ? ON : OFF,
    animation: `${frames} ${CYCLE_MS}ms linear infinite`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
  });
});
