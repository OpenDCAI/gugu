import { animate, useMotionValue, useReducedMotion, type MotionValue } from 'framer-motion';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useState } from 'react';
import { NAV_COLUMN_WIDTH } from '@/lib/uiRuler';
import { PANEL_SPRING, usePanelAnimatedSize } from './panel-motion';
import { useSidebarPeek } from './sidebar-peek';

/** 侧栏宽度的边界与默认值。min 沿用改造前的 200px;max 取 Codex 同款 520。 */
export const SIDEBAR_MIN_WIDTH_PX = 200;
export const SIDEBAR_MAX_WIDTH_PX = 520;
export const SIDEBAR_DEFAULT_WIDTH_PX = NAV_COLUMN_WIDTH;

const SIDEBAR_WIDTH_STORAGE_KEY = 'gugu.taskpage.sidebarWidth';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH_PX;
  return Math.max(SIDEBAR_MIN_WIDTH_PX, Math.min(SIDEBAR_MAX_WIDTH_PX, width));
}

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH_PX;
    return clampSidebarWidth(Number.parseFloat(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH_PX;
  }
}

function writeStoredSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 存储不可用:宽度这一项丢了就丢了,不该因此让侧栏用不了。
  }
}

export interface WorkspaceLayoutContextValue {
  isLeftOpen: boolean;
  /** 侧栏收起后指针停在左缘/开关钮上,浮出的那一份预览。 */
  isLeftPeeking: boolean;
  /** 用户选定的侧栏宽(px)。收起动画期间它**不变** —— 变的是下面那个。 */
  leftWidth: MotionValue<number>;
  /** 开合进度 0→1,由弹簧驱动。 */
  leftProgress: MotionValue<number>;
  /** 侧栏实际占位宽 = 进度 × 宽。主区宽是"剩下的",所以两者永远同步。 */
  leftAnimatedWidth: MotionValue<number>;
  /** 会话页根元素 —— 浮出预览要按它的左缘算,不是窗口。 */
  workspaceRootRef: RefObject<HTMLDivElement | null>;
  setLeftWidth: (width: number, options?: { persist?: boolean }) => void;
  setCollapsed: (
    side: 'left',
    collapsed: boolean,
    options?: {
      /** 这次收起是用户点按钮触发的:在指针离开之前压住 hover 唤出,否则会立刻回弹。 */
      suppressPeek?: boolean;
    }
  ) => void;
  toggleLeft: () => void;
  /** 开关按钮把自己的悬停状态报进来:悬停满 100ms 也会浮出侧栏。 */
  setTriggerHovered: (hovered: boolean) => void;
  exitZenMode: () => void;
  toggleZenMode: (rightSidebar?: {
    isCollapsed: boolean;
    setCollapsed: (collapsed: boolean) => void;
  }) => void;
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | undefined>(undefined);

/**
 * 会话页外层布局(左侧栏 ↔ 主区)的状态与动效来源。
 *
 * 改造前这里托管的是 react-resizable-panels 的 panel ref,折叠 = 一次瞬间的 flex-grow 改写,
 * 没有可插入过渡的量 —— product spec 那条「尺寸变化必须过渡:面板展开/收缩
 * 不允许瞬跳」在会话页一直是破的。现在宽度由 motion value 持有:
 *
 *     侧栏占位宽 = 进度(弹簧 0→1) × 用户选定宽
 *     主区宽     = 剩下的(flex-1)
 *
 * 于是"面板宽度"和"顶栏让位"读的是同一个数,不存在两条过渡各跑各的。详见 panel-motion.ts。
 *
 * ⚠️ 顺带退掉了 `released-sidebar-collapse`:那是给 #3904「窄宽度自动折叠」擦屁股的一次性放开,
 * 它擦的是 `react-resizable-panels:workspace-outer` 这个键。外层分栏组没了,那个键也随之作废,
 * 新的宽度键有自己的默认值,再也不会有"折了回不来"。
 */
export function useWorkspaceLayoutService(): WorkspaceLayoutContextValue {
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const prefersReducedMotion = useReducedMotion();
  const workspaceRootRef = useRef<HTMLDivElement | null>(null);

  const leftWidth = useMotionValue(readStoredSidebarWidth());
  const leftProgress = useMotionValue(1);
  const leftAnimatedWidth = usePanelAnimatedSize(leftProgress, leftWidth);
  const runningAnimationRef = useRef<{ stop: () => void } | null>(null);

  const zenModeSnapshotRef = useRef<{
    leftOpen: boolean;
    rightCollapsed?: boolean;
    setRightCollapsed?: (collapsed: boolean) => void;
  } | null>(null);

  const peek = useSidebarPeek({
    isLeftOpen,
    rootRef: workspaceRootRef,
    getProgress: () => leftProgress.get(),
    getWidth: () => leftWidth.get(),
  });
  const { setTriggerHovered, suppressUntilPointerLeaves, dismiss: dismissPeek } = peek;

  const setLeftWidth = useCallback(
    (width: number, options?: { persist?: boolean }) => {
      const next = clampSidebarWidth(width);
      leftWidth.set(next);
      if (options?.persist) writeStoredSidebarWidth(next);
    },
    [leftWidth]
  );

  const setCollapsed = useCallback(
    (_side: 'left', collapsed: boolean, options?: { suppressPeek?: boolean }) => {
      const open = !collapsed;
      // 预览浮着时展开 = 把它钉住:它已经画在那儿了,再从 0 滑一次是重影 —— 直接跳到终值。
      const pin = open && peek.isPeekOpen;
      setIsLeftOpen(open);
      if (collapsed && options?.suppressPeek !== false) suppressUntilPointerLeaves();
      if (open) dismissPeek();

      const target = open ? 1 : 0;
      runningAnimationRef.current?.stop();
      runningAnimationRef.current = null;
      if (pin || prefersReducedMotion) {
        leftProgress.set(target);
        return;
      }
      runningAnimationRef.current = animate(leftProgress, target, PANEL_SPRING);
    },
    [dismissPeek, leftProgress, peek.isPeekOpen, prefersReducedMotion, suppressUntilPointerLeaves]
  );

  const toggleLeft = useCallback(() => {
    setCollapsed('left', isLeftOpen);
  }, [isLeftOpen, setCollapsed]);

  const exitZenMode = useCallback(() => {
    const snapshot = zenModeSnapshotRef.current;
    if (!snapshot) return;

    setCollapsed('left', !snapshot.leftOpen);
    if (snapshot.setRightCollapsed && snapshot.rightCollapsed !== undefined) {
      snapshot.setRightCollapsed(snapshot.rightCollapsed);
    }
    zenModeSnapshotRef.current = null;
  }, [setCollapsed]);

  const toggleZenMode = useCallback(
    (rightSidebar?: { isCollapsed: boolean; setCollapsed: (collapsed: boolean) => void }) => {
      if (zenModeSnapshotRef.current) {
        exitZenMode();
        return;
      }

      zenModeSnapshotRef.current = {
        leftOpen: isLeftOpen,
        rightCollapsed: rightSidebar?.isCollapsed,
        setRightCollapsed: rightSidebar?.setCollapsed,
      };
      setCollapsed('left', true);
      rightSidebar?.setCollapsed(true);
    },
    [exitZenMode, isLeftOpen, setCollapsed]
  );

  return {
    isLeftOpen,
    isLeftPeeking: peek.isPeekOpen,
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    workspaceRootRef,
    setLeftWidth,
    setCollapsed,
    toggleLeft,
    setTriggerHovered,
    exitZenMode,
    toggleZenMode,
  };
}

export function WorkspaceLayoutContextProvider({ children }: { children: ReactNode }) {
  const value = useWorkspaceLayoutService();
  return (
    <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>
  );
}

export function useWorkspaceLayoutContext() {
  const context = useContext(WorkspaceLayoutContext);
  if (!context) {
    throw new Error(
      'useWorkspaceLayoutContext must be used within a WorkspaceLayoutContextProvider'
    );
  }
  return context;
}
