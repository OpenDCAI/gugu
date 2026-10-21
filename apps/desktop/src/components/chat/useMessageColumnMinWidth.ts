import { useCallback, useEffect, useRef, useState } from 'react'

// #1572 的消息列理想宽度。#2203/#2234 要求右栏内容完整可达,不等于右栏必须占满 360px。
// 窄窗两栏共同收缩:消息列至少 240px(与工作区 SidePanelSplit 一致),右栏内容放不下时内部滚动。
// 800px 截图的聊天区约 528px:消息列由 168px 保到 240px,输入文本区约 100px;
// 同时还能容下既有 280px 的话题分栏,不把另一栏挤出视口。
export const CHAT_AREA_MIN_WIDTH = 380
const CHAT_AREA_COMPACT_MIN_WIDTH = 240
// 360 是常规右栏的首选宽度,不是窄窗的硬下限。RightPanel 允许收缩,以内部滚动保住内容。
export const RIGHT_PANEL_DEFAULT_WIDTH = 360

// @@@2234 中栏 min-width 的自适应计算 —— 从 ChatAreaPanel 抽出(god-file 行数冻结 + 自包含可测)。
//
// 有右栏时消息列下限在 240–380 之间随行宽变化,不超过行本身;右栏使用剩余空间。
// 无功能栏时不超过所在聊天面的实宽;助理和任务两列并排时,各自都能窄于理想 380,输入框不被裁掉。
//
// ResizeObserver 覆盖窗口缩窄 + 拖列表两条改行宽的路径;attachPanelsRow 回调 ref 让观测器随该行(随 activeChat)
// 挂卸重建;无 ResizeObserver 环境回退 window resize(同 ResizableChatListPane 兜底)。存**派生后**的 min-width
// 而非原始像素:仅当算出的地板真变了才 setState → 宽窗内拖动(地板恒 380)不触发整面板逐帧重渲染。展开/收起面板
// 本身也要重算(行宽没变但预留与否变了),故 effect 依赖 rightPanelOpen。
export function useMessageColumnMinWidth(
  rightPanelOpen: boolean,
  mobile: boolean,
): { messageColumnMinWidth: number; attachPanelsRow: (node: HTMLDivElement | null) => void } {
  const rightPanelOpenRef = useRef(rightPanelOpen)
  rightPanelOpenRef.current = rightPanelOpen
  const [messageColumnMinWidth, setMessageColumnMinWidth] = useState(mobile ? 0 : CHAT_AREA_MIN_WIDTH)
  const rowNodeRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const recompute = useCallback(() => {
    const node = rowNodeRef.current
    const rowWidth = node ? node.getBoundingClientRect().width : Number.POSITIVE_INFINITY
    const next = mobile
      ? 0
      : rightPanelOpenRef.current
        ? Math.min(rowWidth, Math.max(CHAT_AREA_COMPACT_MIN_WIDTH, Math.min(CHAT_AREA_MIN_WIDTH, rowWidth - RIGHT_PANEL_DEFAULT_WIDTH)))
        : Math.min(CHAT_AREA_MIN_WIDTH, rowWidth)
    setMessageColumnMinWidth((prev) => (prev === next ? prev : next))
  }, [mobile])

  const attachPanelsRow = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    window.removeEventListener('resize', recompute) // no-op if never added
    rowNodeRef.current = node
    if (!node) return
    recompute()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', recompute) // jsdom/老环境兜底
      return
    }
    const observer = new ResizeObserver(recompute)
    observer.observe(node)
    observerRef.current = observer
  }, [recompute])

  // 面板展开/收起时行宽未必变(ResizeObserver 不触发),但「是否预留右栏下限」变了 → 显式重算。
  useEffect(() => { recompute() }, [rightPanelOpen, recompute])

  return { messageColumnMinWidth, attachPanelsRow }
}
