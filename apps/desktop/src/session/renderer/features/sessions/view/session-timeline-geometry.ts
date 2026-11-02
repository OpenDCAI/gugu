/**
 * The rail's geometry, split out of the component so「一条 260 轮的会话画成什么样」
 * 判得起来 —— 组件那边要 React + mobx + 一整套 store 才挂得起来(#4874 把取刻度的
 * `session-timeline-turns` 拆出去,也是同一个理由)。
 *
 * 参照 owner 2026-09-04 指的 vivid-layer Chat Minimap:12px 行 + 2px 药丸 + 3× 余弦透镜。
 *
 * ⚠️ 12px 是**定死的行高,不是上限**:轨道能站下多少格由它的高度决定(`railCapacity`),
 * 轮数超过就一格代表多轮(`turnsPerTick`),❌ 不是把行距压细。压细那条路试过 ——
 * 260 轮时一行 3.3px,owner 2026-09-10:「要不弄个上限吧,现在太密了」。所以任何长度的
 * 会话画出来都是同一种疏密,轨道也永远落在框内。
 */

/** Marker row height and the resting pill length. */
export const ITEM_SIZE = 12;
/** Hovered pill length as a multiple of ITEM_SIZE. */
export const MAGNIFICATION = 3;
/** Neighbours on each side of the hovered marker that swell with it. */
const LENS_RANGE = 3;
/** Pill thickness. */
export const PILL_WIDTH = 2;
/**
 * 静止时的药丸长度按来源分(owner 2026-10-28 定方案 A):你的话满墨加长,投递的短 —— 一眼找到「我说过的话」。
 * 连续投递合成的那一段更粗(PILL_WIDTH × 2)、更淡,长度同投递。
 */
export const OWN_PILL_LENGTH = 18;
export const DELIVERY_PILL_LENGTH = 8;
export const RUN_PILL_WIDTH = PILL_WIDTH * 2;
/** The reading line: px below the viewport top; the first row crossing it names「the turn being read」. */
export const READING_LINE = 24;
/** Synthetic rows flattenTier mints per turn (`${turnId}:<suffix>`), so they map back to their turn too. */
export const SYNTHETIC_ROW_SUFFIXES = ['day', 'process', 'outcome'];

/**
 * 这条轨道站得下多少格 —— 就是它的高度除以行高。0 = 还没量到(首帧之前),
 * 调用方按「一轮一格」处理。
 */
export function railCapacity(railHeight: number): number {
  if (!Number.isFinite(railHeight) || railHeight <= 0) return 0;
  return Math.max(1, Math.floor(railHeight / ITEM_SIZE));
}

/**
 * 一格代表几轮。放得下就 1(一轮一格,与短会话一模一样);放不下就均摊到站得下的格子里。
 * 均摊而不是「只画最近 N 轮」:轨道要能带你回到会话开头 —— owner 撞见这个 bug 时
 * 干的就是往上翻。
 */
export function turnsPerTick(count: number, capacity: number): number {
  if (count <= 0 || capacity <= 0) return 1;
  return Math.max(1, Math.ceil(count / capacity));
}

// Adapted from Mantine Lens Select (MIT), via the vivid-layer Chat Minimap.
/** 透镜给各格加同样的长度(中心 +ITEM_SIZE×(MAGNIFICATION−1)),从各自的静止长度 `base` 起:长短关系保留,放大后伸进 transcript 的距离与从前一样。 */
export function markerWidth(index: number, hoveredIndex: number | null, base: number = ITEM_SIZE): number {
  if (hoveredIndex === null) return base;
  const distance = Math.abs(index - hoveredIndex);
  if (distance >= LENS_RANGE) return base;
  const factor = (1 + Math.cos((Math.PI * distance) / LENS_RANGE)) / 2;
  return base + (ITEM_SIZE * MAGNIFICATION - ITEM_SIZE) * factor;
}
