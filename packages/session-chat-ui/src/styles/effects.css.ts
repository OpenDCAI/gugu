/**
 * effects.css.ts — ports the @utility effects from the old tokens.css §3.
 *
 * text-shimmer, fade-overlay-top/bottom, and plan-spinner are now typed VE
 * style objects. Components import the class names directly instead of using
 * Tailwind utility strings.
 *
 * The keyframe names are scoped by VE so they never collide in the host app.
 */

import { globalStyle, keyframes, style } from '@vanilla-extract/css';
import { vars } from './theme.css';

// ── Keyframes ─────────────────────────────────────────────────────────────────

const shimmerSweep = keyframes({
  from: { transform: 'translateX(0)' },
  to: { transform: 'translateX(var(--text-shimmer-sweep-end, 50%))' },
});
const shimmerInk = keyframes({
  from: { transform: 'translateX(0)' },
  to: { transform: 'translateX(var(--text-shimmer-ink-end, -200%))' },
});

// The running bar loops without a timer: the sweep takes the first half of each cycle at the same
// 20 steps as above, then the value stays still until the next cycle.
const shimmerSweepHeld = keyframes({
  '0%': { transform: 'translateX(0)' },
  '50%': { transform: 'translateX(var(--text-shimmer-sweep-end, 50%))' },
  '100%': { transform: 'translateX(var(--text-shimmer-sweep-end, 50%))' },
});
const shimmerInkHeld = keyframes({
  '0%': { transform: 'translateX(0)' },
  '50%': { transform: 'translateX(var(--text-shimmer-ink-end, -200%))' },
  '100%': { transform: 'translateX(var(--text-shimmer-ink-end, -200%))' },
});

const planSpin = keyframes({
  to: { transform: 'rotate(360deg)' },
});

// ── artifact surface ──────────────────────────────────────────────────────────

/**
 * 「agent 正文」与「内嵌的逐字产物」之间的那道边界。三个调用点共用:代码块 / 表格 /
 * mermaid —— 它们各自手抄过一遍同一条公式,三份定义处。ui-visual-spec §8 缺口 3
 * 点名了这份重复,这里把它并成一档。
 *
 * ⚠️ **导出的是规则对象,不是 class,这一点是被实测逼出来的。**
 * 用 `style([artifactSurface, {…}])` 组合过一版,三个块全瞎了(mermaid 契约测试报
 * `no mermaid wrapper: expected +0 to be 1`)。根因在 VE 源码里:
 * `composeStylesIntoSet(set, ...className.trim().split(' '))` —— 组合的导出是**空格分隔
 * 的多个类名**,而这三个文件都用 `globalStyle(\`${x} svg\`)` 之类拿它拼选择器,
 * `"a b"` 一插进去就变成后代选择器 `.a .b svg`,再也匹配不到任何东西。
 * ⇒ 谁的 class 会被拼进选择器,谁就不能用 composition。
 *
 * ⚠️ 只收「面本身」的两条声明。滚动、内边距、hover、boxSizing 都是各块自己的事,
 * 留在各自文件里 —— 把它们一起收进来会让这个名字名不副实,下一个人就不敢用它了。
 *
 * ⚠️ 这不是「卡片」。§6 说层次用颜色表达而不是投影:这道面**不填色、不投影**,
 * 只画一条闭合的边。契约测试(`markdown-rows.contract.test.tsx`)两个方向都钉着它 ——
 * 加填色红、加投影红、把边剥掉也红。
 */
export const artifactSurface = {
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusMd,
} as const;

// ── text-shimmer ──────────────────────────────────────────────────────────────

/**
 * 「有名字的动作正在跑」这个记号。5 个调用点共用（tool / file-op / subagent / diff /
 * CollapseHeader），它是 transcript「agent 在动」的那一个动效 —— 一轮还什么都没有时，
 * 在动的是这一轮的时间头（turn-process 行，同样经 CollapseHeader 微光）。
 */
export const textShimmer = style({
  position: 'relative',
  color: 'transparent',
  WebkitTextFillColor: 'transparent',
  '@media': { '(prefers-reduced-motion: reduce)': { color: vars.fgPassive, WebkitTextFillColor: vars.fgPassive } },
});

/** Same sweep and hold as ShimmerText, as one looping animation: a label that has no row lifecycle to rewind it. */
export const textShimmerLoop = style({
  vars: {
    '--text-shimmer-sweep-name': shimmerSweepHeld,
    '--text-shimmer-ink-name': shimmerInkHeld,
    '--text-shimmer-duration': '2s',
    '--text-shimmer-iterations': 'infinite',
  },
});

export const textShimmerClip = style({
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  isolation: 'isolate',
  contain: 'paint',
  animationDelay: 'inherit',
  // Reduced motion keeps the same flat passive text as before, with no frozen band.
  '@media': { '(prefers-reduced-motion: reduce)': { display: 'none' } },
});

// The base glyphs sit still and unmasked; only the light layer moves. It
// sweeps one repeat in one second at 20 steps, then finishes; ShimmerText
// waits one second before rewinding the same animations. Opposite glyph
// transforms keep its text still. One masked layer per label: each masked
// layer is composited on every frame while anything on screen animates, so
// masking the base glyphs as well cost about a third of the GPU time.
const sweep = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 'var(--text-shimmer-left, -200%)',
  width: 'var(--text-shimmer-width, 400%)',
  transform: 'translateX(var(--text-shimmer-idle-sweep, 0%))',
} as const;

export const textShimmerBaseSweep = style(sweep);

export const textShimmerSweep = style({
  ...sweep,
  maskImage: 'var(--text-shimmer-light-mask, linear-gradient(90deg, transparent 30%, white 50%, transparent 70%))',
  maskSize: 'var(--text-shimmer-mask-size, 50% 100%)',
  maskRepeat: 'repeat',
  animation: `var(--text-shimmer-sweep-name, ${shimmerSweep}) var(--text-shimmer-duration, 1s) var(--text-shimmer-easing, steps(20, end)) var(--text-shimmer-iterations, 1) forwards`,
  animationDelay: 'inherit',
});

export const textShimmerInk = style({
  display: 'block',
  width: 'var(--text-shimmer-ink-width, 25%)',
  marginLeft: 'var(--text-shimmer-ink-left, 50%)',
  transform: 'translateX(var(--text-shimmer-idle-ink, 0%))',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: `var(--text-shimmer-base, ${vars.fgPassive})`,
  WebkitTextFillColor: `var(--text-shimmer-base, ${vars.fgPassive})`,
  '::before': { content: 'attr(data-shimmer-text)' },
});

export const textShimmerLightInk = style({
  color: `var(--text-shimmer-light, ${vars.fgMuted})`,
  WebkitTextFillColor: `var(--text-shimmer-light, ${vars.fgMuted})`,
  animation: `var(--text-shimmer-ink-name, ${shimmerInk}) var(--text-shimmer-duration, 1s) var(--text-shimmer-easing, steps(20, end)) var(--text-shimmer-iterations, 1) forwards`,
  animationDelay: 'inherit',
});

/** Shared with the host message viewport; paint only, never intercept selection or scrolling. */
export const viewportTopFade = {
  height: 16,
  pointerEvents: 'none',
  background: 'linear-gradient(to bottom, var(--chat-bg), transparent)',
} as const;

// ── fade-overlay-top ──────────────────────────────────────────────────────────

export const fadeOverlayTop = style({
  background: `linear-gradient(
    to bottom,
    ${vars.bg} 0%,
    color-mix(in oklab, ${vars.bg}, transparent 50%) 40%,
    color-mix(in oklab, ${vars.bg}, transparent 100%) 100%
  )`,
});

// ── fade-overlay-bottom ───────────────────────────────────────────────────────

export const fadeOverlayBottom = style({
  background: `linear-gradient(
    to top,
    ${vars.bg} 0%,
    color-mix(in oklab, ${vars.bg}, transparent 50%) 40%,
    color-mix(in oklab, ${vars.bg}, transparent 100%) 100%
  )`,
});

// ── plan-spinner ──────────────────────────────────────────────────────────────

export const planSpinner = style({
  transformOrigin: 'center',
  transformBox: 'fill-box',
  animation: `${planSpin} 1s linear infinite`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
});

/** Multiline labels use the same measured line breaks in the composited glyph texture. */
export const textShimmerMultiline = style({});
globalStyle(`${textShimmerMultiline} ${textShimmerInk}`, { whiteSpace: 'inherit', overflowWrap: 'inherit', textOverflow: 'clip' });
