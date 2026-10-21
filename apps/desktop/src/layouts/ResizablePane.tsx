import { motion, useMotionValue, useTransform, type MotionStyle } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { ListColumnLayout } from '../hooks/useListColumnCollapse'
import { panelContentLayout } from '../session/renderer/lib/layout/panel-motion'

/** 可收起时内容窄过它就不再跟着缩,改为整块滑走 + 淡出(一行 = 头像 + 名字两个字 + 时间)。 */
const COLLAPSE_CONTENT_MIN_PX = 160

/**
 * 可拖宽窄的一栏 + 它边上那条分割线。
 *
 * @@@5856 这个文件是从 ResizableChatListPane 里**抽出来**的,不是照着又写了一份:
 * 话题分栏也要能拖(owner 2026-09-19:「你只要保证分割线可分割就行了」),而拖拽这件事的难点
 * 全在边界情形——指针捕获、窗口失焦/切后台时要收尾、PointerEvent 不可用时回落 mouse、
 * 容器变窄时上限跟着缩、键盘也要能调。这些左边那一栏两年前就一条条踩过了。
 * 再写一份的代价不是多几十行,是把这些边界情形统统退回未解决态(见 memory:复用原件,别重写)。
 *
 * 两处的差别只有三样,全部做成参数:分割线在哪一边、宽度怎么夹、以及叫什么名字。
 */
export type ResizablePaneEdge = 'left' | 'right'

// 分割线本身:❌ 不写成内联样式块,两条边各一份常量(WebkitAppRegion 不在 CSSProperties 里,要断言)。
const RESIZER_STYLE: Record<ResizablePaneEdge, CSSProperties> = {
  right: {
    position: 'absolute', top: 0, right: -3, bottom: 0, width: 6,
    cursor: 'col-resize', zIndex: 'var(--z-raised)', WebkitAppRegion: 'no-drag',
  } as CSSProperties,
  left: {
    position: 'absolute', top: 0, left: -3, bottom: 0, width: 6,
    cursor: 'col-resize', zIndex: 'var(--z-raised)', WebkitAppRegion: 'no-drag',
  } as CSSProperties,
}

// 可收起的那一栏自己裁溢出(收起动画要裁),分割线整条收进栏内,❌ 骑在边界上被裁掉一半抓取区。
const RESIZER_INSET_STYLE: Record<ResizablePaneEdge, CSSProperties> = {
  right: { ...RESIZER_STYLE.right, right: 0 },
  left: { ...RESIZER_STYLE.left, left: 0 },
}

export function ResizablePane({
  children,
  edge,
  hidden,
  mobile,
  minWidth,
  maxWidthForAvailable,
  clampWidth,
  onWidthChange,
  onWidthCommit,
  width,
  initialMaxWidth,
  resizeLabel,
  paneTestId,
  handleTestId,
  collapse,
}: {
  children: ReactNode
  /** 分割线贴在这一栏的哪条边。左栏(会话列表)是 right,右栏(话题分栏)是 left。 */
  edge: ResizablePaneEdge
  hidden: boolean
  mobile: boolean
  minWidth: number
  /** 容器可用宽度 → 这一栏此刻允许的最大宽度(给旁边那栏留出它的地板)。 */
  maxWidthForAvailable: (availableWidth: number) => number
  clampWidth: (width: number) => number
  /**
   * 还没量到容器宽度之前的上限 —— 必填。
   * @@@5856 抽取时这里写的是 clampWidth(Infinity),而 clamp 对非有限值返回的是 **DEFAULT**不是 MAX
   * (会话列表 240 而非 360,话题栏 340 而非 720)。于是存过宽宽度的人每次启动先画一帧窄的再弹回来
   * (修正它的 syncMaxWidth 在 useEffect 里,跑在绘制之后)。这个值只能由那一栏自己说。
   */
  initialMaxWidth: number
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  width: number
  resizeLabel: string
  paneTestId: string
  handleTestId: string
  /** 可收起的那一栏(会话列表,#6753):占位宽、内容排布与悬停浮出由 useListColumnCollapse 算好,这里只绑上。 */
  collapse?: ListColumnLayout
}) {
  const [dragging, setDragging] = useState(false)
  const [availableMaxWidth, setAvailableMaxWidth] = useState(initialMaxWidth)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<{
    startX: number
    startWidth: number
    lastWidth: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)
  const widthRef = useRef(width)
  const renderedWidth = Math.min(width, availableMaxWidth)
  // 左边那条分割线:指针往右走 = 这一栏变窄,所以位移取反。
  const direction = edge === 'right' ? 1 : -1
  const layout = mobile ? undefined : collapse
  const collapseWidth = layout?.width
  const collapseRoot = layout?.rootRef
  useLayoutEffect(() => {
    collapseWidth?.set(renderedWidth)
  }, [collapseWidth, renderedWidth])
  const setPaneRef = useCallback((node: HTMLDivElement | null) => {
    paneRef.current = node
    if (collapseRoot) collapseRoot.current = node
  }, [collapseRoot])
  // 与会话页 workspace-layout 同一组派生:停靠态内容跟着占位宽缩到下限再整块滑走;浮出态整宽从左缘滑入、不挤正文。
  // 宽度用这一次渲染的 renderedWidth(闭包),❌ 另拿一个宽度 MotionValue 组合:拖分割线时它在提交阶段才被写,
  // 那一刻组合值的订阅正在换新,最后一次写会丢(mac1 实测:拖 +40,占位停在 +36)。
  const idle = useMotionValue(1)
  const progress = layout?.progress ?? idle
  const peek = layout?.peekProgress ?? idle
  const docked = (p: number) => panelContentLayout(p, renderedWidth, COLLAPSE_CONTENT_MIN_PX)
  const dockedWidth = useTransform(progress, (p) => Math.max(0, Math.min(1, p)) * renderedWidth)
  const contentWidth = useTransform(progress, (p) => (p > 0 ? docked(p).width : renderedWidth))
  const contentOpacity = useTransform([progress, peek], ([p, pk]: number[]) => (p > 0 ? docked(p).opacity : pk))
  const contentX = useTransform([progress, peek], ([p, pk]: number[]) => (p > 0 ? docked(p).offset : (pk - 1) * renderedWidth))
  // 收起时占位宽走弹簧、这一栏裁掉溢出;浮出时不裁,内容整宽盖在旁边那栏上。
  const collapseStyle: MotionStyle | undefined = layout && {
    width: dockedWidth,
    flex: '0 0 auto',
    minWidth: 0,
    overflow: layout.peekVisible ? 'visible' : 'hidden',
    zIndex: layout.peekVisible ? 'var(--z-float)' : undefined,
  }
  const contentStyle: MotionStyle | undefined = layout && {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    width: contentWidth,
    x: contentX,
    opacity: contentOpacity,
    pointerEvents: layout.open || layout.peekVisible ? 'auto' : 'none',
    boxShadow: layout.peekVisible ? 'var(--shadow-lift)' : undefined,
  }

  useEffect(() => {
    widthRef.current = renderedWidth
  }, [renderedWidth])

  useEffect(() => {
    const container = paneRef.current?.parentElement
    if (!container) return undefined
    const syncMaxWidth = () => {
      setAvailableMaxWidth(maxWidthForAvailable(container.getBoundingClientRect().width))
    }
    syncMaxWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncMaxWidth)
      return () => window.removeEventListener('resize', syncMaxWidth)
    }
    const observer = new ResizeObserver(syncMaxWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [maxWidthForAvailable])

  const finishResize = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    try {
      onWidthCommit(session.lastWidth)
    } finally {
      document.body.style.cursor = session.previousCursor
      document.body.style.userSelect = session.previousUserSelect
      sessionRef.current = null
      setDragging(false)
    }
  }, [onWidthCommit])

  const resizeToClientX = useCallback((clientX: number) => {
    const session = sessionRef.current
    if (!session) return
    const nextWidth = Math.min(
      clampWidth(session.startWidth + (clientX - session.startX) * direction),
      availableMaxWidth,
    )
    session.lastWidth = nextWidth
    onWidthChange(nextWidth)
  }, [availableMaxWidth, clampWidth, direction, onWidthChange])

  useEffect(() => {
    if (!dragging) return undefined
    const handleMove = (event: PointerEvent | MouseEvent) => resizeToClientX(event.clientX)
    const handleUp = () => finishResize()
    const handleWindowBlur = () => finishResize()
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') finishResize()
    }
    if (window.PointerEvent) {
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
    } else {
      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleUp)
    }
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pagehide', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('pagehide', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      finishResize()
    }
  }, [dragging, finishResize, resizeToClientX])

  const beginResize = useCallback((clientX: number) => {
    if (mobile) return
    if (sessionRef.current) return
    sessionRef.current = {
      startX: clientX,
      startWidth: widthRef.current,
      lastWidth: widthRef.current,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setDragging(true)
  }, [mobile])

  const beginPointerResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    beginResize(event.clientX)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [beginResize])

  const beginMouseResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (window.PointerEvent) return
    event.preventDefault()
    event.stopPropagation()
    beginResize(event.clientX)
  }, [beginResize])

  const stepWidth = useCallback((delta: number) => {
    const nextWidth = Math.min(clampWidth(widthRef.current + delta), availableMaxWidth)
    onWidthChange(nextWidth)
    onWidthCommit(nextWidth)
  }, [availableMaxWidth, clampWidth, onWidthChange, onWidthCommit])

  return (
    <motion.div
      ref={setPaneRef}
      data-testid={paneTestId}
      data-list-collapsed={layout && !layout.open ? '' : undefined}
      style={{
        position: 'relative',
        width: mobile ? '100%' : renderedWidth,
        flex: mobile ? 1 : `0 0 ${renderedWidth}px`,
        // #1312 兜底:桌面下给这一栏一个真实 min-width 地板(= 可调下限),而非 0。
        // 旁边那栏因异常(多面板并存)产生超额 min-content 压力时,这一栏也不会被挤到不可用宽度。
        minWidth: mobile ? 0 : minWidth,
        minHeight: 0,
        display: hidden ? 'none' : 'flex',
        ...collapseStyle,
      }}
    >
      {contentStyle ? <motion.div style={contentStyle}>{children}</motion.div> : children}
      {!mobile && (!layout || layout.open) && (
        <div
          data-testid={handleTestId}
          role="separator"
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={availableMaxWidth}
          aria-valuenow={renderedWidth}
          tabIndex={0}
          className="gg-resizer"
          data-dragging={dragging || undefined}
          onPointerDown={beginPointerResize}
          onMouseDown={beginMouseResize}
          onLostPointerCapture={finishResize}
          onKeyDown={(event) => {
            // 键盘方向与**视觉**一致:左箭头把分割线往左推。对右栏来说那是变宽,所以同样乘 direction。
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              stepWidth((event.shiftKey ? -24 : -8) * direction)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              stepWidth((event.shiftKey ? 24 : 8) * direction)
            } else if (event.key === 'Home') {
              event.preventDefault()
              onWidthChange(minWidth)
              onWidthCommit(minWidth)
            } else if (event.key === 'End') {
              event.preventDefault()
              onWidthChange(availableMaxWidth)
              onWidthCommit(availableMaxWidth)
            }
          }}
          style={(layout ? RESIZER_INSET_STYLE : RESIZER_STYLE)[edge]}
        />
      )}
    </motion.div>
  )
}
