import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * @@@sessionpage layout — 侧栏 / 工作区面板开合动效的**唯一**来源。
 *
 * 三条要点缺一就不"丝滑",按重要性排:
 *
 * 1. **一个弹簧驱动全部**。开合是一个 0→1 的 MotionValue:面板占位宽 = 进度 × 目标宽,
 *    内容透明度 = 同一个进度,顶栏让位也读同一个值。❌ 不许"面板一条 CSS 过渡、按钮另一条"——
 *    两条独立过渡的曲线与起止时刻永远对不齐,中途错开就是"顿"的来源。
 * 2. **内容一个像素都不许被啃掉**(owner 2026-09-13 推翻了原来那条「内容恒定宽、被外层裁掉」)。
 *    固定宽 + 裁切读起来不是「板在收」,是「一块白板压住了列表」:内容原地不动,只有边界在走,
 *    于是标题被切成半个字、行尾的状态点整个没了。改为内容宽度跟着占位宽走,窄到最小宽度才
 *    停住并整块滑走 + 淡出 —— 见 panelContentLayout。侧栏的行本来就是单行 truncate,
 *    跟着缩只是标题变短,不会出现当初担心的折行抖动。
 * 3. **减弱动态直接跳终值**(product spec:prefers-reduced-motion 全部降级为即时)。
 *
 * ⚠️ 这条弹簧同时被左侧栏与右工作区面板使用 —— product spec 要求
 * 「同一场景全产品同档」。要改节奏改这一处,❌ 别在调用点各写各的。
 */
export const PANEL_SPRING = { type: 'spring', duration: 0.5, bounce: 0.1 } as const;

/**
 * 拖分隔条到目标宽度的一半以下就判定为"收起"(Codex 同款:它的 `min * 0.5`)。
 * 比"拖到 0 才算收起"好用得多 —— 手不用拖到底,而且松手位置离阈值远,不会误判。
 */
export const PANEL_SNAP_RATIO = 0.5;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 面板开合进度 0→1。
 *
 * 首帧不放动画:否则每次挂载(切咕咕 tab 回来、会话页重挂)侧栏都会自己滑出来一次。
 * `place` 换了也不放:同一个组件换了一处地方在画(会话页切会话不重挂),那是到了另一条会话,
 * 不是这块面板在开合 —— 直接落到那里的形态。
 */
export function usePanelProgress(isOpen: boolean, place?: string): MotionValue<number> {
  const progress = useMotionValue(isOpen ? 1 : 0);
  const prefersReducedMotion = useReducedMotion();
  const isFirstRun = useRef(true);
  const lastPlace = useRef(place);

  // Layout effect: when `place` changes the panel lands in the new session's state before paint.
  useLayoutEffect(() => {
    const target = isOpen ? 1 : 0;
    const movedPlace = lastPlace.current !== place;
    lastPlace.current = place;
    if (isFirstRun.current || movedPlace || prefersReducedMotion) {
      isFirstRun.current = false;
      progress.set(target);
      return;
    }
    const controls = animate(progress, target, PANEL_SPRING);
    return () => controls.stop();
  }, [isOpen, place, prefersReducedMotion, progress]);

  return progress;
}

/**
 * 面板实际占位宽 = 进度 × 目标宽。
 *
 * 主区宽度是**剩下的那部分**(flex-1),所以两者由同一个值推出、绝不会脱节。
 */
export function usePanelAnimatedSize(
  progress: MotionValue<number>,
  size: MotionValue<number>
): MotionValue<number> {
  return useTransform([progress, size], (latest: number[]) => clamp01(latest[0]) * latest[1]);
}

/**
 * 内容层的布局 —— 与 {@link usePanelAnimatedSize} 是同一个进度的两面。
 *
 * 外层占位宽 = 进度 × 目标宽,并且裁掉溢出。内容层怎么配合,决定了收起读作「板在收」
 * 还是「内容被啃掉一条」:
 *
 *  · **宽度跟着占位宽走**,直到 `minSize` 为止 —— 这一段内容完整,左右两端都在,
 *    一个像素都不丢(行本来就是单行 truncate,变窄只是标题变短,不会折行抖动)。
 *  · **窄过 `minSize` 之后不再缩**:再缩内容就挤烂了。这时改为整块贴着裁切窗口那条边
 *    滑走,并且同步淡出 —— 「正在消失」而不是「被切掉半个字」。
 *
 * owner 2026-09-13 定的判据是这条的来源:先是「折叠产生遮罩,内容看不到了」(内容原地
 * 不动、右边被一刀切),改成整块平移之后又是「右边有了,但是左边又丢失了,正常应该
 * 两边都有,并且更合适的是弄个最小宽度,不要有东西丢失或者遮罩」。所以平移只留给
 * 最后那截窄过最小宽度的行程,其余全程内容自适应。
 *
 * @param progress 开合进度 0→1。
 * @param size 目标宽(用户选定的那个宽度)。
 * @param minSize 内容还成形的最小宽度;窄过它就滑走 + 淡出。
 * @param edge 内容层贴的是容器的哪条边 —— 也就是面板从哪一侧滑出。
 *   `'start'` = 贴左缘(左侧栏),`'end'` = 贴右缘(右工作区面板)。
 */
export function panelContentLayout(
  progress: number,
  size: number,
  minSize: number,
  edge: 'start' | 'end' = 'start'
): { width: number; offset: number; opacity: number } {
  const visible = clamp01(progress) * size;
  const floor = Math.max(0, Math.min(minSize, size));
  const width = Math.max(visible, floor);
  const overflow = Math.max(0, floor - visible);
  return {
    width,
    // 贴哪条边就往哪条边的反方向让:内容在裁切窗口里始终顶着那条边,不会凭空空出一截。
    // `|| 0` 是为了不返回 -0 —— 它在断言里(Object.is)与 0 不是一回事。
    offset: (edge === 'start' ? -overflow : overflow) || 0,
    opacity: floor > 0 ? clamp01(visible / floor) : 1,
  };
}

/**
 * 收起动画**放完**之前别卸载面板,否则它会在收到一半时凭空消失。
 *
 * 返回 true 期间调用方应保持面板挂载;进度真正落到 0 之后才转 false。
 *
 * ⚠️ 判据用的是进度值**穿过 0** 这件事,不是 `animationComplete` 事件:后者只在动画正常跑完时
 * 派发,被 `stop()` 打断(收起放到一半又展开)、或走 `set()` 直接落位(首帧、减弱动态)时都没有,
 * 面板就会永远停在"还挂着"。
 *
 * change 是**每帧**都来的,所以用一个 ref 自己挡住:setState 只在真的穿过 0 时调用一次。
 * ❌ 别指望"传同一个值 React 会自己跳过" —— 那条快路径只在该 fiber 没有待处理更新时成立,
 * 而动画期间父层随时可能有,一旦不成立就是每帧一次重渲染整棵侧栏。
 */
export function usePanelMounted(isOpen: boolean, progress: MotionValue<number>): boolean {
  const hasSizeRef = useRef(progress.get() > 0);
  const [hasSize, setHasSize] = useState(hasSizeRef.current);

  useMotionValueEvent(progress, 'change', (value) => {
    const next = value > 0;
    if (hasSizeRef.current === next) return;
    hasSizeRef.current = next;
    setHasSize(next);
  });

  return isOpen || hasSize;
}
