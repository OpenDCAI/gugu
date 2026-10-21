import { motion, type MotionValue } from 'framer-motion';
import { useRef } from 'react';
import { cn } from '@renderer/utils/utils';
import { PANEL_SNAP_RATIO } from './panel-motion';

/** 键盘调宽的步长 —— 与 react-resizable-panels 的方向键行为同档,别让改造把纯键盘用户丢下。 */
const KEYBOARD_STEP_PX = 16;
/** 命中带宽度(px)。视觉上的那条发丝线由面板自己的边框画,这一条只负责"抓得住"。 */
const HIT_STRIP_PX = 4;

interface PanelResizeHandleProps {
  /** 把手长在面板的哪一边:侧栏(面板在左)= 'end',工作区面板(面板在右)= 'start'。 */
  edge: 'start' | 'end';
  /** 面板此刻的**占位**宽 —— 把手骑在这条边界上,所以它和面板是一起动的。 */
  offset: MotionValue<number>;
  /** 面板当前的目标宽(px)。拖拽以它为基准,而不是读 DOM —— 读 DOM 会读到动画中的中间值。 */
  getSize: () => number;
  minSize: number;
  maxSize: () => number;
  /** 拖拽过程中每一帧的新宽度(已 clamp)。 */
  onSize: (size: number) => void;
  /** 拖到收起阈值以下:调用方负责把面板收起。 */
  onCollapse: () => void;
  /** 松手。落在阈值以上时给出最终宽度,调用方负责持久化。 */
  onSizeCommit: (size: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * 侧栏 / 工作区面板的拖拽分隔条。
 *
 * 为什么不继续用 react-resizable-panels:它把面板宽度记在自己的 flex 布局里,程序性 collapse 是
 * **瞬间**改 flex-grow —— 没有可插入过渡的量(product spec「尺寸变化必须过渡,
 * 面板展开/收缩不允许瞬跳」在会话页一直是破的)。想让它动起来只能每帧调 `resize()`,但那会一路撞上
 * 它自己的收起阈值(动画中途宽度必然低于 minSize,面板会在半路被判成收起而吸走)和它每次布局提交
 * 都落 localStorage 的行为。所以宽度改由 motion value 持有,分隔条只负责把指针位移翻译成宽度。
 *
 * **它是脱离文档流的**(绝对定位骑在边界上),这一点是动效的一部分而不是写法偏好:留在流里的话,
 * 面板一开始收起它就整条消失,主区会先横跳一个把手宽再开始滑 —— 那一下正是"发虚"。
 * 写法是 `group absolute … cursor-col-resize`,可见的线只在 hover 时才出现。
 *
 * 收起判据用 `PANEL_SNAP_RATIO`:拖到目标宽一半以下就收起,不必拖到 0。
 */
export function PanelResizeHandle({
  edge,
  offset,
  getSize,
  minSize,
  maxSize,
  onSize,
  onCollapse,
  onSizeCommit,
  onDraggingChange,
  ariaLabel,
  className,
}: PanelResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startSize: number } | null>(null);

  // 面板在左时,指针右移 = 变宽;面板在右时,指针右移 = 变窄。
  const direction = edge === 'end' ? 1 : -1;

  const clampSize = (size: number) => Math.max(minSize, Math.min(maxSize(), size));

  const applyDelta = (deltaPx: number, startSize: number) => {
    const raw = startSize + deltaPx * direction;
    // 收起阈值判在 clamp **之前**:clamp 会把小于 minSize 的值抬回 minSize,
    // 收起意图就再也读不出来了。
    if (raw < minSize * PANEL_SNAP_RATIO) {
      onCollapse();
      return null;
    }
    const next = clampSize(raw);
    onSize(next);
    return next;
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onDraggingChange?.(false);
    const raw = drag.startSize + (event.clientX - drag.startX) * direction;
    if (raw >= minSize * PANEL_SNAP_RATIO) onSizeCommit(clampSize(raw));
  };

  return (
    <motion.div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-panel-resize-handle=""
      className={cn(
        // 与面板同档 z-40,靠 DOM 序压过它:同档后挂载者在上。不抬的话骑在边界上的命中带
        // 有一半被面板盖住,能抓的只剩 2px。
        'absolute inset-y-0 z-40 cursor-col-resize outline-none transition-colors hover:bg-border/60',
        className
      )}
      style={{
        width: HIT_STRIP_PX,
        // 骑在边界上:把手中线对准面板边缘,两侧各分一半命中带。
        ...(edge === 'end'
          ? { left: offset, marginLeft: -HIT_STRIP_PX / 2 }
          : { right: offset, marginRight: -HIT_STRIP_PX / 2 }),
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startSize: getSize(),
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        applyDelta(event.clientX - drag.startX, drag.startSize);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX;
        const next = applyDelta(delta, getSize());
        if (next != null) onSizeCommit(next);
      }}
    />
  );
}
