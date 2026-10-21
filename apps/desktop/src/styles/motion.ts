// @@@motion-token-projection (#4323) — tokens.css 是动效值的唯一真相；本文件是它给 JS 的投影。
//
// CSS 里的转场直接写 `var(--dur-med)` / `var(--ease)` 就完了，但有两类动效**读不到 CSS 变量**：
//   · framer-motion 的 `transition={{ duration, ease }}` 要的是数字与控制点数组；
//   · Base UI 的 tooltip `delay` / `closeDelay` 要的是毫秒数。
// 于是这些地方历来各写各的数（0.2s、0.12s、cubic-bezier(.4,0,.2,1)…），token 改了它们不跟。
//
// 投影**不是第二个真相**：tests/unit/desktop/styles/motionTokenProjection.test.ts 逐条解析 tokens.css
// 的 `--dur-*` / `--ease*` 声明并与下面的值对账，任一侧改了而另一侧没改就红。
// 想改时长或曲线 ⇒ 改 tokens.css，再让这条单测把你带到这里。

/** `--dur-*` 三档，毫秒。 */
export const DUR_FAST_MS = 150
export const DUR_MED_MS = 200
export const DUR_SLOW_MS = 300

/** `--ease*` 三条曲线的控制点。framer-motion 的 `ease` 直接吃这个四元组。 */
export const EASE = [0.2, 0.8, 0.2, 1] as const
export const EASE_SPRING = [0.22, 1, 0.36, 1] as const
export const EASE_POP = [0.16, 1, 0.3, 1] as const

export type EaseCurve = typeof EASE | typeof EASE_SPRING | typeof EASE_POP

/** framer-motion 的 transition 字面量，省得每个调用点自己把秒和曲线拼一遍。 */
export function tween(durationMs: number, ease: EaseCurve = EASE) {
  return { type: 'tween', duration: durationMs / 1000, ease } as const
}

// ── 下面这两个数不是 CSS 的投影，是 tooltip 原语自己的契约 ──────────────────────
// hover 意图延迟只存在于 JS（Base UI 的 delay/closeDelay），CSS 里没有对应 token，
// 也没有任何 CSS 规则会读它 —— 写进 tokens.css 就是一条没有消费者的死 token。
// 它归 Tooltip 原语所有，放在这里只是为了和时长曲线待在同一处，调用方一律不再自己传。

/** 指针停留多久才弹 tooltip。够长以躲开「扫过即闪」，又不至于让人以为没有说明。 */
export const TOOLTIP_OPEN_DELAY_MS = 320
/** 移开后多久收。留一点余量，让指针在相邻图标之间移动时不闪断。 */
export const TOOLTIP_CLOSE_DELAY_MS = 80
