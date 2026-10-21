import { useCallback, useEffect, useState } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import {
  hasCustomWindowControls,
  hasWindowTitlebarRow,
  readRendererPlatform,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
  WINDOW_CONTROL_BUTTON_WIDTH_PX,
  WINDOW_TITLEBAR_HEIGHT_PX,
} from '../lib/window-chrome'
import {
  hostCatalog,
  isResolvedLocale,
  type WindowChromeLabels,
} from '../../shared/host-localization'
import type { ShellLocation } from '../lib/shellNavigationHistory'
import { useShellNavigation } from '../hooks/useShellNavigation'
import { ListColumnToggle } from './PanelToggleButtons'
import { WindowTitleBar } from './WindowTitleBar'

// @@@822 frameless 统一标题栏的自绘窗口控制 —— 仅 Windows/Linux 的 Electron 渲染。
// Mac 保留原生交通灯(titleBarStyle:hiddenInset),web/非 Electron 无边框控制 → 这些场景返回 null。
// 窗口控制(46×40 按钮 + min/max/close SVG + close 红 #E81123),配色按 gugu 暗色 token。
// 通过 window.desktopWindow(preload 桥)驱动 main 的 window:minimize/maximize/close IPC。
//
// 两种摆法,同一组按钮(本文件的 WindowControls 是唯一挂载入口):
//   · Windows —— 住在标题栏行里(WindowTitleBar 收下这组按钮元素),不压内容;
//   · Linux   —— 浮在内容右上角(fixed),内容按 windowControlsWidth 让位。

export type DesktopWindowBridge = NonNullable<Window['desktopWindow']>

export interface WindowChromeState {
  dw: DesktopWindowBridge | undefined
  maximized: boolean
  labels: WindowChromeLabels
}

/** 最大化状态与本地化按钮名(主进程随宿主语言推送)。标题栏的「视图」菜单也读同一份。 */
function useWindowChromeState(): WindowChromeState {
  const dw = typeof window !== 'undefined' ? window.desktopWindow : undefined
  const [maximized, setMaximized] = useState(false)
  const [labels, setLabels] = useState<WindowChromeLabels>(() => {
    if (dw?.getChromeLabels) return dw.getChromeLabels()
    const documentLocale = typeof document === 'undefined' ? null : document.documentElement.lang
    return hostCatalog(isResolvedLocale(documentLocale) ? documentLocale : 'zh-CN').windowChrome
  })

  useEffect(() => {
    if (!dw) return
    let active = true
    void dw.isMaximized().then((m) => {
      if (active) setMaximized(m)
    })
    const unsubscribe = dw.onMaximizedChange(setMaximized)
    const unsubscribeLabels = dw.onChromeLabelsChange?.(setLabels)
    return () => {
      active = false
      unsubscribe()
      unsubscribeLabels?.()
    }
  }, [dw])

  return { dw, maximized, labels }
}

/** 最小化 / 最大化(还原) / 关闭 三颗钮。高度随宿主那一行走,宽度是 Windows 惯例的 46。 */
function WindowControlButtons({ chrome, height }: { chrome: WindowChromeState & { dw: DesktopWindowBridge }; height: number }) {
  const { dw, maximized, labels } = chrome
  // @@@2322 hover 从命令式 e.currentTarget.style 迁到 tokens.css 的 .gg-winctl 类;色值逐值不变
  // (关闭钮红底 #E81123 是 Windows 平台惯例,保留专属色)。btnBase 只剩布局,状态样式归类。
  const btnBase: React.CSSProperties = {
    width: WINDOW_CONTROL_BUTTON_WIDTH_PX,
    height,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    WebkitAppRegion: 'no-drag',
  } as React.CSSProperties

  return (
    <>
      <button
        type="button"
        className="gg-winctl"
        style={btnBase}
        onClick={() => dw.minimize()}
        aria-label={labels.minimize}
      >
        <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="gg-winctl"
        style={btnBase}
        onClick={() => dw.maximize()}
        aria-label={maximized ? labels.restore : labels.maximize}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 0v2H0v8h8V8h2V0H2zm6 8H1V3h7v5zM9 7V1H3v1h5v5h1z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="0" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="gg-winctl gg-winctl--close"
        style={btnBase}
        onClick={() => dw.close()}
        aria-label={labels.close}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z" fill="currentColor" />
        </svg>
      </button>
    </>
  )
}

export interface WindowControlsProps {
  activeTab: SidebarTab
  mobile: boolean
  activeChatId: string | null
  chats: readonly { id: string }[]
  sessionHostAvailable: boolean
  onSelectTab: (tab: SidebarTab) => void
  onOpenChat: (chatId: string | null) => void
  onNewAgent: () => void
  onOpenSettings: (section: ActiveSection) => void
}

/**
 * 壳里窗口 chrome 的唯一挂载点(MainLayout 把它挂在整棵壳的最后,理由见那里 @@@822 的注释):
 * Windows 画标题栏行,Linux 画浮在内容右上角的三颗钮,mac / 网页 / 手机什么都不画。
 *
 * 后退 / 前进的壳级历史也住在这里 —— 它只服务于标题栏,❌ 摊进 MainLayout(那个文件在 IM 迁移账本里,
 * 有行数预算)。历史跨 tab 切换一直活着,因为这个组件和壳同生同灭。
 */
export function WindowControls({
  activeTab,
  mobile,
  activeChatId,
  chats,
  sessionHostAvailable,
  onSelectTab,
  onOpenChat,
  onNewAgent,
  onOpenSettings,
}: WindowControlsProps) {
  const titlebarRow = hasWindowTitlebarRow(readRendererPlatform())
  const location: ShellLocation | null = !titlebarRow
    ? null
    : activeTab === 'chats'
      ? { tab: 'chats', chatId: activeChatId }
      : activeTab === 'contacts' || activeTab === 'tasks'
        ? { tab: activeTab }
        : null
  // 后退到一条已经被删掉 / 退出的会话没有意义:那一格跳过。
  const reachable = useCallback((target: ShellLocation) => {
    if (target.tab === 'tasks') return sessionHostAvailable
    if (target.tab === 'chats') return target.chatId === null || chats.some((chat) => chat.id === target.chatId)
    return true
  }, [chats, sessionHostAvailable])
  // 与点侧栏同一个入口(selectTab:关设置弹窗、切 tab);选中会话一变,壳自己会收起创建草稿面。
  const apply = useCallback((target: ShellLocation) => {
    onSelectTab(target.tab)
    if (target.tab === 'chats') onOpenChat(target.chatId)
  }, [onOpenChat, onSelectTab])
  const navigation = useShellNavigation({ location, reachable, apply })
  const chrome = useWindowChromeState()
  const { dw } = chrome

  if (!titlebarRow) {
    return (
      <>
        {/* 对话页的列表栏开关(#6753):与会话页根部那颗是同一个组件、同一个坐标(rail 宽 + 8, 6),挂在壳这里;
            会话页那颗由会话页自己挂,通讯录没有列表栏就不挂。挂在壳的最后,no-drag 才压得住列表头的拖拽带。 */}
        {!mobile && activeTab === 'chats' ? (
          <div className="gg-list-toggle-float">
            <ListColumnToggle slot="list:chats" />
          </div>
        ) : null}
        <FloatingWindowControls chrome={chrome} />
      </>
    )
  }
  if (!dw) return null
  return (
    <WindowTitleBar
      desktopWindow={dw}
      controls={<WindowControlButtons chrome={{ ...chrome, dw }} height={WINDOW_TITLEBAR_HEIGHT_PX} />}
      navigation={navigation}
      activeTab={activeTab}
      onSelectTab={onSelectTab}
      onNewAgent={onNewAgent}
      onOpenSettings={onOpenSettings}
    />
  )
}

/** Linux:三颗钮浮在内容右上角。 */
function FloatingWindowControls({ chrome }: { chrome: WindowChromeState }) {
  // 仅 Electron-on-Linux 浮在内容上;data-platform 在 main.tsx 注入(mac/win/linux/other)。
  const platform = readRendererPlatform(typeof document === 'undefined' ? undefined : document)
  const { dw } = chrome
  if (!dw || !hasCustomWindowControls(platform)) return null

  return (
    <div
      style={
        {
          position: 'fixed',
          top: 0,
          right: 0,
          height: WINDOW_CONTROL_BAR_HEIGHT_PX,
          display: 'flex',
          zIndex: 'var(--z-chrome)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
      data-window-controls=""
    >
      <WindowControlButtons chrome={{ ...chrome, dw }} height={WINDOW_CONTROL_BAR_HEIGHT_PX} />
    </div>
  )
}
