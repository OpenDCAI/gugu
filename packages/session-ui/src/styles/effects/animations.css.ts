/**
 * animations.css.ts — Vanilla Extract keyframes for overlay primitives.
 * (dialog, sheet, popover, dropdown, select, combobox)
 *
 *  - kfPopupIn/Out           fade + zoom (for dialogs and side-less popups)
 *  - kfPopupInSlideFrom*     fade + zoom + 0.5rem slide (for positioner popups)
 *  - kfSlide{In/Out}{From/To}{Right/Left}  full-width slides (for sheets)
 */

import { globalStyle, keyframes } from '@vanilla-extract/css';

// ── Motion tokens ────────────────────────────────────────────────────────────────────
// Tiered durations per product spec: fast = exits / state
// switches, med = menu/popover/dialog entrances, slow = sheet/drawer slides.
// Exits replay the entrance one tier faster (有入必有出, 出场降一档).
// Values inherit the gugu host tokens (--dur-*/--ease via the skin bridge)
// with identical literal fallbacks for standalone use (storybook, tests).

export const durFast = 'var(--dur-fast, 120ms)';
export const durMed = 'var(--dur-med, 180ms)';
export const easeStandard = 'var(--ease, cubic-bezier(0.2, 0.8, 0.2, 1))';

// ── Fade (backdrop / overlay) ─────────────────────────────────────────────────

export const kfFadeIn = keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const kfFadeOut = keyframes({
  from: { opacity: 1 },
  to: { opacity: 0 },
});

// ── Popup: fade + zoom (dialog, no-side popups) ───────────────────────────────

export const kfPopupIn = keyframes({
  from: { opacity: 0, transform: 'scale(0.95)' },
  to: { opacity: 1, transform: 'scale(1)' },
});

export const kfPopupOut = keyframes({
  from: { opacity: 1, transform: 'scale(1)' },
  to: { opacity: 0, transform: 'scale(0.95)' },
});

// ── Popup: fade + zoom + slide (positioner popups, 0.5rem offset) ─────────────
// data-side=bottom → popup opens below trigger → slides IN from the top
export const kfPopupInSlideFromTop = keyframes({
  from: { opacity: 0, transform: 'scale(0.95) translateY(-0.5rem)' },
  to: { opacity: 1, transform: 'scale(1) translateY(0)' },
});

// data-side=top → popup opens above trigger → slides IN from the bottom
export const kfPopupInSlideFromBottom = keyframes({
  from: { opacity: 0, transform: 'scale(0.95) translateY(0.5rem)' },
  to: { opacity: 1, transform: 'scale(1) translateY(0)' },
});

// data-side=right / inline-end → popup to the right → slides IN from the left
export const kfPopupInSlideFromLeft = keyframes({
  from: { opacity: 0, transform: 'scale(0.95) translateX(-0.5rem)' },
  to: { opacity: 1, transform: 'scale(1) translateX(0)' },
});

// data-side=left / inline-start → popup to the left → slides IN from the right
export const kfPopupInSlideFromRight = keyframes({
  from: { opacity: 0, transform: 'scale(0.95) translateX(0.5rem)' },
  to: { opacity: 1, transform: 'scale(1) translateX(0)' },
});

// ── Sheet slides (full translate, no zoom) ────────────────────────────────────

// ── Convenience: selectors blocks for positioner popups ───────────────────────
// Import the individual keyframe constants above and compose into style() calls.
// The per-side selectors use higher specificity ([data-open][data-side=*]) so
// they override the fallback [data-open] animation without !important.

// ── prefers-reduced-motion 兜底 (Refs #6104) ──────────────────────────────────
//
// design.md:「**Every one of these is disabled under `prefers-reduced-motion`,
// and any new keyframe must be too.**」
//
// 本文件导出 12 个 keyframes,它们被 popup-surface / dialog / sheet / combobox 等浮层消费。
// 在**咕咕宿主里**它们本来就被压住:apps/desktop/src/styles/tokens.css 那条万能选择器兜底
// 作用于整个 document,而 #2802 拆掉 shadow root 之后会话页也在同一个 document 里。
// ⇒ 这一条补的不是那种场合,而是**脱开宿主**的那些:独立 storybook、组件测试、
//   以及任何把 @gugu/session-ui 装进别的壳里的用法 —— 那里没有任何东西压它们。
//
// 为什么用万能选择器而不是逐个 keyframe 点名:12 个里漏一个不会有任何东西报错,
// 而「下一个人新加一个 keyframe」是必然发生的事(design.md 那句 "any new keyframe must be too"
// 正说明它靠的是人自觉)。万能选择器对新增免疫。
// ⚠️ iteration-count 必须配对压成 1 —— 只压时长的话 infinite 动画会变成每圈 0.01ms 的高频闪烁,
// 比不降级更糟。
// ⚠️ 这段与宿主那段**同选择器同声明**,两者同时在场是幂等的(不是「两套值」)。
globalStyle('*', {
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important',
      // ⚠️ 宿主那段还带一条 `scroll-behavior: auto !important`,这里**没有**,不是漏:
      // vanilla-extract 的 scrollBehavior 类型是关键字联合(不是 string),写不进 `!important`;
      // 而本包源码里 `scroll-behavior: smooth` 的实测命中是 **0** ⇒ 没有需要被压过的声明,
      // auto 本来就是初始值。真有人在本包里写 smooth 时,得连同这条一起重判(见 §10 的清单)。
    },
  },
});
