/**
 * Vendored from assistant-ui Elements（`elements-range`，registry 里 94 个元素中 20 个直接依赖它）。
 *
 * 上游：`https://r.assistant-ui.com/elements-range.json`
 * 上游依赖：无（零 npm 依赖、零 registry 依赖）—— 这一份是**逐字抄过来的**，
 * 相对上游 0 处改动，因为它只有算术、不含任何视觉取值。
 *
 * 它存在的理由：Elements 全是「props 进、回调出」的纯展示组件，数值 prop 由调用方的 state 驱动，
 * 因此可能是负数、越界或 NaN。不归一化就会直接进 DOM —— 负百分比是无效 CSS 宽度，浏览器丢弃它，
 * 于是进度条停在天然满宽；负的切片长度则从数组末尾倒数，而不是返回空。
 */

/**
 * 把 value 夹到 `min…max`。NaN 先判，映射为 `min`。
 * 其余情况下空集合可以让上下界反转，此时 `max` 赢：`clamp(3, 1, 0)` 是 `0` ——
 * 正是这一点让「至少一项」的下界在集合为空时仍然产出零项。
 */
export function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 前 `count` 项，允许 `count` 越界。 */
export function take<T>(items: readonly T[], count: number) {
  return items.slice(0, Math.floor(clamp(count, 0, items.length)));
}

/** `index` 在 `items` 中指向的合法位置，允许 `index` 越界。 */
export function indexIn<T>(items: readonly T[], index: number) {
  return Math.floor(clamp(index, 0, Math.max(0, items.length - 1)));
}

/** `index` 处的项，允许 `index` 越界。 */
export function at<T>(items: readonly T[], index: number) {
  if (items.length === 0) return undefined;
  return items[indexIn(items, index)];
}

/** `value` 占 `total` 的比例，输出 `0…100` 的百分数。 */
export function pct(value: number, total: number) {
  if (!(total > 0)) return 0;
  return clamp((value / total) * 100, 0, 100);
}

/** 已完成项数占 `total`，输出 `0…total`。 */
export function progressOf(index: number, total: number) {
  if (!(total > 0)) return 0;
  return Math.floor(clamp(index, 0, total));
}
