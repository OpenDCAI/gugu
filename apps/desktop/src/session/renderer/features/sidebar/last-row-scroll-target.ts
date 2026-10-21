/**
 * 把**末行**滚进视野时的目标 scrollTop;已经整行可见就返回 null(不滚)。
 *
 * 为什么末行要自己算:TanStack Virtual 的 `getOffsetForIndex` 对「末行 + align=end」走捷径 ——
 * 直接返回 `getMaxScrollOffset()`(滚动容器能滚到的最底)。列表独占滚动容器时那正好是列表末端;
 * 但侧栏三区共用一个滚动容器(见 sidebar-scroll-context),列表下方还有「任务」区,容器最底远在
 * 列表之下,于是「把末行滚进视野」反而把它滚出了视野上方。
 *
 * 其余行不受影响:走的是 `getOffsetForAlignment`,那里只把容器最底当上限做钳制,是对的。
 */
export function lastRowScrollTarget(input: {
  /** 列表末端在滚动容器内容坐标里的位置 = scrollMargin + totalSize */
  listEnd: number;
  /** 末行自己的高度 */
  rowHeight: number;
  /** 容器当前的 scrollTop */
  scrollTop: number;
  /** 容器视口高度 */
  clientHeight: number;
}): number | null {
  const { listEnd, rowHeight, scrollTop, clientHeight } = input;
  // 在视野下方 → 对齐到视野底
  if (listEnd > scrollTop + clientHeight) return Math.max(0, listEnd - clientHeight);
  // 在视野上方 → 对齐到视野顶
  if (listEnd - rowHeight < scrollTop) return Math.max(0, listEnd - rowHeight);
  return null;
}
