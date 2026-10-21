/**
 * effects.css.ts — ports the @utility effects from the old tokens.css §3.
 *
 * text-shimmer, fade-overlay-top/bottom, and plan-spinner are now typed VE
 * style objects. Components import the class names directly instead of using
 * Tailwind utility strings.
 *
 * The keyframe names are scoped by VE so they never collide in the host app.
 */

import { keyframes, style } from '@vanilla-extract/css';
import { vars } from './theme.css';

// ── Keyframes ─────────────────────────────────────────────────────────────────

const shimmerMove = keyframes({
  from: { backgroundPosition: '200% 0' },
  to: { backgroundPosition: '-200% 0' },
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
  background: `linear-gradient(
    90deg,
    ${vars.fgPassive} 0%,
    ${vars.fgPassive} 30%,
    ${vars.fgMuted} 50%,
    ${vars.fgPassive} 70%,
    ${vars.fgPassive} 100%
  )`,
  backgroundSize: '200% 100%',
  backgroundClip: 'text',
  WebkitBackgroundClip: 'text',
  color: 'transparent',
  WebkitTextFillColor: 'transparent',
  animation: `${shimmerMove} 3s linear infinite`,
  /**
   * ⚠️ 这里必须把**渐变本身**也撤掉，不能只写 `animation: none`。
   * 文字的颜色是 `transparent` + `background-clip: text` 画出来的：动画停下后
   * `background-position` 落在 `0% 0%`，于是每个标签都冻结成一道固定的亮暗渐变 ——
   * 静止的花纹比动着的 shimmer 更奇怪，而且每个标签的花纹还随自己的宽度不同。
   * ⇒ 退回 `fgPassive` 平色，正好是这些行不在跑时本来的颜色。
   *
   * 本仓其它动效（`create-height-tween` / `tween-registry` / `ChatRoot:404`）都读这条
   * media query，只有这个记号漏了；#3334 把三处「agent 在动」合成一件时一并补上。
   */
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
      background: 'none',
      backgroundClip: 'border-box',
      WebkitBackgroundClip: 'border-box',
      color: vars.fgPassive,
      WebkitTextFillColor: vars.fgPassive,
    },
  },
});

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
