import { detectPlatform, matchesKeyboardEvent, parseHotkey, type Hotkey } from '@tanstack/hotkeys'
import { animate, useMotionValue, type MotionValue } from 'framer-motion'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { publishPanelToggle, useListHotkey } from '../lib/panelToggles'
import { formatHotkeyText } from '../session/renderer/lib/ui/shortcut-format'
import { APP_SHORTCUTS, resolveDefaultHotkey } from '../session/shared/shortcuts'
import { PANEL_SPRING, usePanelMounted, usePanelProgress } from '../session/renderer/lib/layout/panel-motion'
import { useSidebarPeek } from '../session/renderer/lib/layout/sidebar-peek'

/** 键位表里 toggleLeftSidebar 的默认值 —— 只在会话页从没来过时用(网页装配 / 冷启动那一瞬);之后跟它键位设置里的实际绑定走。 */
const DEFAULT_LIST_TOGGLE_HOTKEY = resolveDefaultHotkey(APP_SHORTCUTS.toggleLeftSidebar) ?? null
const HOTKEY_PLATFORM = detectPlatform()

export interface ListColumnLayout {
  open: boolean
  /** 收起态悬停浮出的预览正画着(含滑出的那段动画)。 */
  peekVisible: boolean
  /** 开合进度 0→1(与会话页侧栏同一条弹簧)。 */
  progress: MotionValue<number>
  /** 浮出预览自己的进度:从左缘滑入。 */
  peekProgress: MotionValue<number>
  /** 这一栏此刻的整宽,只给浮出预览的保持区读 —— 由这一栏自己写进来(它知道夹过上限之后的真实宽度)。 */
  width: MotionValue<number>
  /** 这一栏的根:浮出预览的进入区 / 保持区按它的左缘算。 */
  rootRef: RefObject<HTMLDivElement | null>
}

/**
 * @@@panel-toggles (#6753) 对话页会话列表的收放 —— 与会话页侧栏**同一套**:弹簧与内容排布走 panel-motion,
 * 悬停预览 / 点击钉住走 sidebar-peek,开关语义照会话页 ShellSidebarToggle(开着 → 收起;预览浮着 → 钉住、不放动画;
 * 收着 → 展开)。active = 桌面壳里对话页在前台:只有这时登记进 panelToggles、挂快捷键、听悬停。
 */
export function useListColumnCollapse(active: boolean, initialWidth: number): ListColumnLayout {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(true)
  const reducedMotion = usePrefersReducedMotion()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = useMotionValue(initialWidth)
  const progress = useMotionValue(1)
  const runningRef = useRef<{ stop: () => void } | null>(null)
  const { isPeekOpen, setTriggerHovered, suppressUntilPointerLeaves, dismiss } = useSidebarPeek({
    // 不在前台时当它开着:不挂全局 pointermove,也不会在别的页签上被窗口左缘勾出来。
    isLeftOpen: open || !active,
    rootRef,
    getProgress: () => progress.get(),
    getWidth: () => width.get(),
  })

  const setCollapsed = useCallback((collapsed: boolean) => {
    // 预览浮着时展开 = 把它钉住(同会话页 layout-provider):它已经画在那儿了,再从 0 滑一次是重影。
    const pin = !collapsed && isPeekOpen
    setOpen(!collapsed)
    if (collapsed) suppressUntilPointerLeaves()
    else dismiss()
    runningRef.current?.stop()
    runningRef.current = null
    if (pin || reducedMotion) progress.set(collapsed ? 0 : 1)
    else runningRef.current = animate(progress, collapsed ? 0 : 1, PANEL_SPRING)
  }, [dismiss, isPeekOpen, progress, reducedMotion, suppressUntilPointerLeaves])

  const toggle = useCallback(() => setCollapsed(open), [open, setCollapsed])

  const label = t(open ? 'shell.panelToggles.collapseList' : 'shell.panelToggles.expandList')
  // 与会话页侧栏同一个键(toggleLeftSidebar):会话页在前台时由它自己接(app-keyboard-shortcuts),对话页由这里接。
  const sessionHotkey = useListHotkey()
  const hotkey = (sessionHotkey === undefined ? DEFAULT_LIST_TOGGLE_HOTKEY : sessionHotkey) as Hotkey | null
  useEffect(() => {
    if (!active) return undefined
    const shortcut = hotkey ? formatHotkeyText(hotkey) : undefined
    return publishPanelToggle('list:chats', { open, label, peeking: isPeekOpen, toggle, setTriggerHovered, shortcut })
  }, [active, hotkey, isPeekOpen, label, open, setTriggerHovered, toggle])

  // 离开前台:按钮的 pointerleave 可能不会来(换页签时按钮直接卸载),替它撤掉悬停。
  useEffect(() => {
    if (!active) setTriggerHovered(false)
  }, [active, setTriggerHovered])

  // 捕获阶段、先于会话页的 document 级快捷键:对话页开着「新建 Agent」草稿时会话页也醒着,同一个键不能收到别处去。
  useEffect(() => {
    if (!active || !hotkey) return undefined
    const parsed = parseHotkey(hotkey, HOTKEY_PLATFORM)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesKeyboardEvent(event, parsed, HOTKEY_PLATFORM)) return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, hotkey, toggle])

  const peekProgress = usePanelProgress(isPeekOpen)
  const peekVisible = usePanelMounted(isPeekOpen, peekProgress)
  return { open, peekVisible, progress, peekProgress, width, rootRef }
}
