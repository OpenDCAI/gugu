import { useCallback, useEffect, useRef, useState } from 'react';
import { SHELL_RESTORE_LANE_PX } from '@/lib/window-chrome';

/** 指针贴到会话页左缘多少像素以内算"想看侧栏"(Codex 同款 12px)。 */
export const PEEK_EDGE_ZONE_PX = 12;
/** 指针在开关按钮上**停住**多久才浮出侧栏(Codex 同款 100ms)—— 比它短会在路过按钮时误触发。 */
export const PEEK_TRIGGER_HOVER_MS = 100;
/** 悬停意图:计时期间指针在按钮上挪动超过这么多就重新计时 —— 划过按钮永远停不满那 100ms。 */
export const PEEK_HOVER_INTENT_TOLERANCE_PX = 4;

/**
 * 指针此刻落在哪一区:进入区(贴左缘 12px)与保持区(侧栏宽以内)。
 * 根上面那一截是 Windows 的标题栏行(#6753):那里挨着开关的是菜单,❌ 算进入区(从 ← → 划到「文件」会闪出侧栏);
 * 保持区在那一截只留开关那一列(SHELL_RESTORE_LANE_PX),好让指针从开关直着往下移进浮层。
 */
export function peekZones(
  pointer: { x: number; y: number } | null,
  root: { left: number; top: number },
  width: number
): { inEnterZone: boolean; inStayZone: boolean } {
  if (pointer == null) return { inEnterZone: false, inStayZone: false };
  const offsetX = pointer.x - root.left;
  const aboveRoot = pointer.y < root.top;
  return {
    inEnterZone: !aboveRoot && offsetX >= 0 && offsetX <= PEEK_EDGE_ZONE_PX,
    inStayZone: offsetX >= 0 && offsetX <= (aboveRoot ? SHELL_RESTORE_LANE_PX : width),
  };
}

interface SidebarPeekOptions {
  isLeftOpen: boolean;
  /** 会话页根元素:左缘要按**它**算,不是窗口 —— 会话页左边还有咕咕自己的会话列表。 */
  rootRef: React.RefObject<HTMLElement | null>;
  /** 侧栏开合进度。>0 表示收起动画还没放完,这期间不许浮出(否则刚收就被自己勾回来)。 */
  getProgress: () => number;
  /** 侧栏目标宽 —— 浮出后的"保持区"就是它,指针在浮层里移动不会把它关掉。 */
  getWidth: () => number;
}

export interface SidebarPeek {
  isPeekOpen: boolean;
  /** 开关按钮的悬停状态(悬停满 100ms 也会浮出)。 */
  setTriggerHovered: (hovered: boolean) => void;
  /** 用户**主动点击收起**时调用:在指针离开之前压住 hover 唤出。 */
  suppressUntilPointerLeaves: () => void;
  /** 浮层被钉住(变成常驻侧栏)时调用,清掉浮出态。 */
  dismiss: () => void;
}

/**
 * 侧栏收起后的"浮出预览"。
 *
 * 三段行为,少一段就难用:
 *  · **进入区比保持区小**。指针贴到左缘 12px 以内浮出,但只要还在侧栏宽度以内就不收 ——
 *    进入门槛窄(不容易误触发)、退出门槛宽(浮出后手可以自然地移到列表上)。
 *  · **浮层不挤压正文**。它是覆盖层,主区一动不动 —— 只是"看一眼",不是"打开"。
 *  · **点击收起之后抑制回弹**。点完按钮指针还停在原地,而按钮本身就压在进入区上;
 *    不抑制的话侧栏会在收起动画还没放完时立刻被自己勾回来,看上去像按钮坏了。
 *    抑制到指针**同时**离开按钮和进入区为止。
 */
export function useSidebarPeek({
  isLeftOpen,
  rootRef,
  getProgress,
  getWidth,
}: SidebarPeekOptions): SidebarPeek {
  const [isPeekOpen, setPeekOpen] = useState(false);
  const isPeekOpenRef = useRef(false);
  const isTriggerHoveredRef = useRef(false);
  const isSuppressedRef = useRef(false);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const commit = useCallback((next: boolean) => {
    if (isPeekOpenRef.current === next) return;
    isPeekOpenRef.current = next;
    setPeekOpen(next);
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current == null) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  const evaluate = useCallback(
    (hoverElapsed = false) => {
      // 侧栏本来就开着,或收起动画还在放 —— 都不是"浮出预览"该出现的时刻。
      if (isLeftOpen || getProgress() > 0) {
        clearHoverTimer();
        commit(false);
        return;
      }

      const { inEnterZone, inStayZone } = peekZones(
        pointerRef.current,
        rootRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 },
        getWidth()
      );

      if (isSuppressedRef.current) {
        // 指针同时离开按钮和进入区,才解除抑制 —— 否则"点了收起、手没动"就会立刻回弹。
        if (!isTriggerHoveredRef.current && !inEnterZone) isSuppressedRef.current = false;
        clearHoverTimer();
        commit(false);
        return;
      }

      const wantedByHover = hoverElapsed || (isTriggerHoveredRef.current && isPeekOpenRef.current);
      commit(isPeekOpenRef.current ? inStayZone || wantedByHover : inEnterZone || wantedByHover);
    },
    [clearHoverTimer, commit, getProgress, getWidth, isLeftOpen, rootRef]
  );

  const armHoverTimer = useCallback(() => {
    clearHoverTimer();
    hoverAnchorRef.current = pointerRef.current;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      evaluate(true);
    }, PEEK_TRIGGER_HOVER_MS);
  }, [clearHoverTimer, evaluate]);

  useEffect(() => {
    // 侧栏开着时不挂全局 pointermove —— 这是一条每次鼠标移动都跑的监听,
    // 只在它真的可能生效(侧栏收起)的时候才存在。
    if (isLeftOpen) return;

    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const anchor = hoverAnchorRef.current;
      if (
        hoverTimerRef.current != null &&
        anchor != null &&
        Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) > PEEK_HOVER_INTENT_TOLERANCE_PX
      ) {
        armHoverTimer();
      }
      evaluate();
    };
    // 指针离开窗口时按"移到了很远"处理,免得浮层挂在那儿收不回去。
    const onPointerLeave = () => {
      pointerRef.current = null;
      evaluate();
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [armHoverTimer, evaluate, isLeftOpen]);

  // 侧栏被展开 / 收起时立刻复算一次,别等下一次指针移动。
  useEffect(() => {
    evaluate();
  }, [evaluate, isLeftOpen]);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const setTriggerHovered = useCallback(
    (hovered: boolean) => {
      isTriggerHoveredRef.current = hovered;
      clearHoverTimer();
      if (hovered && !isLeftOpen) armHoverTimer();
      evaluate();
    },
    [armHoverTimer, clearHoverTimer, evaluate, isLeftOpen]
  );

  const suppressUntilPointerLeaves = useCallback(() => {
    isSuppressedRef.current = true;
    clearHoverTimer();
    commit(false);
  }, [clearHoverTimer, commit]);

  const dismiss = useCallback(() => {
    clearHoverTimer();
    commit(false);
  }, [clearHoverTimer, commit]);

  return { isPeekOpen, setTriggerHovered, suppressUntilPointerLeaves, dismiss };
}
