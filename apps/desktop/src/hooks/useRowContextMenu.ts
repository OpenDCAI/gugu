import { useCallback, useEffect, useState } from 'react'
import { UI_EVENTS } from '../lib/uiEvents'

// #886 — per-row right-click menu state (open pos + outside-click/closeContextMenus close),
// 抽出复用：移动端 ContactRow 与桌面 Agent/PersonContactRow 共用同款交互（对齐 ChatRow）。
// #3253 单独成文件：与 ContactRowActions 的组件同处一个模块会触发 react-refresh/only-export-components
// —— 混导出会让整个模块退出 fast refresh，改一行样式就整树重挂。
export function useRowContextMenu() {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menuPos) return
    const close = () => setMenuPos(null)
    document.addEventListener(UI_EVENTS.closeContextMenus, close as EventListener)
    return () => {
      document.removeEventListener(UI_EVENTS.closeContextMenus, close as EventListener)
    }
  }, [menuPos])
  const openMenu = useCallback((at: { x: number; y: number }) => {
    document.dispatchEvent(new CustomEvent(UI_EVENTS.closeContextMenus))
    setMenuPos(at)
  }, [])
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    openMenu({ x: event.clientX, y: event.clientY })
  }
  return { menuPos, openMenu, onContextMenu, closeMenu: () => setMenuPos(null) }
}
