import { Menubar } from '@base-ui/react/menubar'
import { useRef, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { ArrowLeft, ArrowRight } from '@/lib/icons'
import { listSlotOf, usePanelToggle } from '../lib/panelToggles'
import { UI_EVENTS } from '../lib/uiEvents'
import type { WindowMenuCommand } from '../../shared/window-menu-commands'
import type { ShellNavigation } from '../hooks/useShellNavigation'
import { FilePanelToggle } from './PanelToggleButtons'
import { IconButton } from './ui/IconButton'
import { DropdownMenu, MenuItem, MenuSeparator } from './ui/Menu'
import type { DesktopWindowBridge } from './WindowControls'
import './WindowTitleBar.css'

/**
 * @@@win-titlebar-row — Windows 的独立标题栏行:标准 Windows 应用的那条顶栏。
 *
 *   [← →] [文件 编辑 视图 帮助] ·········(拖拽区)········· [◨] [– □ ×]
 *
 * The list toggle lives beside sidebar layout in the content header. Menus have the same
 * starting position on every tab; the file toggle remains beside window controls.
 *
 * 颜色与最左侧栏相同(--nav-rail),同在窗口底层;其下的区域关系与 mac 同一套(tokens.css 的
 * @@@win-titlebar-row)。拖窗口只归这一行。
 *
 * 菜单里只放**已经存在**的动作(新建 Agent、设置、反馈、更新说明、关于、切 tab、窗口缩放),
 * 这一行不发明新功能;快捷键提示只写真的按得出来的组合(Chromium 自带的编辑键、应用菜单的缩放键)。
 */

/** 菜单弹出前焦点在哪(会话页与咕咕同在 light DOM,一个 activeElement 就够)。 */
function focusedElement(): HTMLElement | null {
  const element = document.activeElement
  return element instanceof HTMLElement && element !== document.body ? element : null
}

export interface WindowTitleBarProps {
  /** 窗口桥(preload 的 desktopWindow);只在它存在时才会画这一行。 */
  desktopWindow: DesktopWindowBridge
  /** 最小化 / 最大化 / 关闭 —— 由挂载入口 WindowControls 交进来(按钮实现与状态都住在那边)。 */
  controls: ReactNode
  navigation: ShellNavigation
  activeTab: SidebarTab
  onSelectTab: (tab: SidebarTab) => void
  onNewAgent: () => void
  onOpenSettings: (section: ActiveSection) => void
}

export function WindowTitleBar({ desktopWindow: dw, controls, navigation, activeTab, onSelectTab, onNewAgent, onOpenSettings }: WindowTitleBarProps) {
  const { t } = useTranslation('main')
  const menubarRef = useRef<HTMLDivElement>(null)
  // 菜单关掉后焦点回到打开前的那个元素(Base UI 的 finalFocus),而不是停在菜单按钮上 ——
  // 与原生菜单一致:在输入框里点「编辑 → 粘贴」,粘完光标还在输入框里。
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  // 编辑 / 缩放命令等菜单**关完**再下:关闭动画期间焦点还停在菜单项上(Base UI 在动画结束后才把焦点还回去),
  // 这时下「全选」会选中整页而不是输入框(实测:Undo 碰巧不挑焦点,Select all 挑)。
  const pendingCommandRef = useRef<WindowMenuCommand | null>(null)
  const listPanel = usePanelToggle(listSlotOf(activeTab))
  const filePanel = usePanelToggle(activeTab === 'tasks' ? 'files' : null)

  const rememberFocus = (event: SyntheticEvent) => {
    // 弹层是 portal 出去的,但 React 事件沿组件树冒泡 —— 点菜单项的 pointerdown 也会到这里,
    // 那时焦点在菜单项上。只认真正落在菜单栏 DOM 里的事件(按菜单按钮 / 在按钮上按键)。
    const menubar = menubarRef.current
    if (!menubar || !(event.target instanceof Node) || !menubar.contains(event.target)) return
    const active = focusedElement()
    // 焦点已经在菜单栏或某个打开着的菜单里(键盘左右走、开着「编辑」又去点「视图」):保留打开前记下的那个,
    // ❌ 覆盖成菜单按钮或弹层 —— 弹层马上就卸载,记下它等于把命令下给「当时碰巧有焦点的东西」。
    if (active && (menubar.contains(active) || active.closest('[role="menu"]'))) return
    restoreFocusRef.current = active
  }

  const runWindowCommand = (command: WindowMenuCommand) => {
    pendingCommandRef.current = command
  }

  const flushWindowCommand = () => {
    const command = pendingCommandRef.current
    if (!command) return
    pendingCommandRef.current = null
    const target = restoreFocusRef.current
    if (target?.isConnected) target.focus({ preventScroll: true })
    dw.runMenuCommand?.(command)
  }

  return (
    // 高度走 --window-titlebar-height(main.tsx 从 WINDOW_TITLEBAR_HEIGHT_PX 写入),见 WindowTitleBar.css。
    <div className="gg-titlebar" data-window-titlebar="">
      {/* ← → 占侧栏那一列(同宽、居中):菜单于是从 rail 右缘起,与下面的列表左缘对齐。
          不放应用图标 —— 主人 2026-09-27:最左上角的咕咕图标去掉。 */}
      <div className="gg-titlebar-nav">
        <IconButton
          size="sm"
          aria-label={t('shell.titlebar.goBack')}
          title={t('shell.titlebar.goBack')}
          disabled={!navigation.canGoBack}
          onClick={navigation.goBack}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={t('shell.titlebar.goForward')}
          title={t('shell.titlebar.goForward')}
          disabled={!navigation.canGoForward}
          onClick={navigation.goForward}
        >
          <ArrowRight />
        </IconButton>
      </div>

      <Menubar
        ref={menubarRef}
        className="gg-titlebar-menubar"
        modal={false}
        aria-label={t('shell.titlebar.menubar')}
        onPointerDownCapture={rememberFocus}
        onKeyDownCapture={rememberFocus}
      >
        <TitlebarMenu label={t('shell.titlebar.menus.file')} restoreFocusRef={restoreFocusRef} onClosed={flushWindowCommand}>
          <MenuItem onClick={onNewAgent}>{t('shell.titlebar.items.newAgent')}</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => onOpenSettings('account')}>{t('shell.titlebar.items.settings')}</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => dw.close()}>{t('shell.titlebar.items.exit')}</MenuItem>
        </TitlebarMenu>

        <TitlebarMenu label={t('shell.titlebar.menus.edit')} restoreFocusRef={restoreFocusRef} onClosed={flushWindowCommand}>
          <MenuItem shortcut="Ctrl+Z" onClick={() => runWindowCommand('undo')}>{t('shell.titlebar.items.undo')}</MenuItem>
          <MenuItem shortcut="Ctrl+Y" onClick={() => runWindowCommand('redo')}>{t('shell.titlebar.items.redo')}</MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="Ctrl+X" onClick={() => runWindowCommand('cut')}>{t('shell.titlebar.items.cut')}</MenuItem>
          <MenuItem shortcut="Ctrl+C" onClick={() => runWindowCommand('copy')}>{t('shell.titlebar.items.copy')}</MenuItem>
          <MenuItem shortcut="Ctrl+V" onClick={() => runWindowCommand('paste')}>{t('shell.titlebar.items.paste')}</MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="Ctrl+A" onClick={() => runWindowCommand('selectAll')}>{t('shell.titlebar.items.selectAll')}</MenuItem>
        </TitlebarMenu>

        <TitlebarMenu label={t('shell.titlebar.menus.view')} restoreFocusRef={restoreFocusRef} onClosed={flushWindowCommand}>
          {/* gugu-dev#181「项目」「对话」合成「消息」:都在会话页侧栏里,同最左栏那一格。 */}
          <TabItem tab="tasks" activeTab={activeTab} onSelectTab={onSelectTab}>{t('shell.titlebar.items.messages')}</TabItem>
          <TabItem tab="contacts" activeTab={activeTab} onSelectTab={onSelectTab}>{t('shell.titlebar.items.contacts')}</TabItem>
          <MenuSeparator />
          <MenuItem shortcut={listPanel?.shortcut} disabled={!listPanel} onClick={() => listPanel?.toggle()}>{t('shell.titlebar.items.toggleSidebar')}</MenuItem>
          <MenuItem shortcut={filePanel?.shortcut} disabled={!filePanel} onClick={() => filePanel?.toggle()}>{t('shell.titlebar.items.toggleFilePanel')}</MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!navigation.canGoBack} onClick={navigation.goBack}>{t('shell.titlebar.goBack')}</MenuItem>
          <MenuItem disabled={!navigation.canGoForward} onClick={navigation.goForward}>{t('shell.titlebar.goForward')}</MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="Ctrl+0" onClick={() => runWindowCommand('resetZoom')}>{t('shell.titlebar.items.actualSize')}</MenuItem>
          <MenuItem shortcut="Ctrl++" onClick={() => runWindowCommand('zoomIn')}>{t('shell.titlebar.items.zoomIn')}</MenuItem>
          <MenuItem shortcut="Ctrl+-" onClick={() => runWindowCommand('zoomOut')}>{t('shell.titlebar.items.zoomOut')}</MenuItem>
          <MenuSeparator />
          <MenuItem shortcut="F11" onClick={() => runWindowCommand('toggleFullScreen')}>{t('shell.titlebar.items.fullScreen')}</MenuItem>
        </TitlebarMenu>

        <TitlebarMenu label={t('shell.titlebar.menus.help')} restoreFocusRef={restoreFocusRef} onClosed={flushWindowCommand}>
          {/* 报障入口只有侧栏那一个弹窗,这里只是再给一个开它的地方(同一事件,见 Sidebar)。 */}
          <MenuItem onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageOpenFeedback))}>
            {t('shell.titlebar.items.feedback')}
          </MenuItem>
          <MenuItem onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openReleaseNotes))}>
            {t('shell.titlebar.items.releaseNotes')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => onOpenSettings('about')}>{t('shell.titlebar.items.about')}</MenuItem>
        </TitlebarMenu>
      </Menubar>

      {/* 余下的整段都是拖拽区(容器自己的 app-region: drag);双击它最大化 / 还原,与原生标题栏一致。 */}
      <div className="gg-titlebar-spacer" />

      {activeTab === 'tasks' ? (
        <div className="gg-titlebar-panel-toggle" data-edge="end">
          <FilePanelToggle />
        </div>
      ) : null}

      <div className="gg-titlebar-controls" data-window-controls="">
        {controls}
      </div>
    </div>
  )
}

function TitlebarMenu({
  label,
  restoreFocusRef,
  onClosed,
  children,
}: {
  label: string
  restoreFocusRef: RefObject<HTMLElement | null>
  /** 关闭动画结束之后(焦点已还回去)。 */
  onClosed: () => void
  children: ReactNode
}) {
  return (
    <DropdownMenu.Root modal={false} onOpenChangeComplete={(open) => { if (!open) onClosed() }}>
      <DropdownMenu.Trigger className="gg-titlebar-menu-trigger">{label}</DropdownMenu.Trigger>
      {/* 标题栏行永远不被页面层盖住(模态开着也点得到),它开出来的菜单就得在所有页面层之上 —— 否则看图时点「视图」,菜单开在图下面。 */}
      <DropdownMenu.Content className="gg-titlebar-menu-popup" sideOffset={2} finalFocus={restoreFocusRef} zIndex="var(--z-chrome-menu)">
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

function TabItem({
  tab,
  activeTab,
  onSelectTab,
  children,
}: {
  tab: SidebarTab
  activeTab: SidebarTab
  onSelectTab: (tab: SidebarTab) => void
  children: ReactNode
}) {
  // 已经在这一页时点它什么都不变(与点侧栏同一个入口:selectTab)。
  return <MenuItem onClick={() => { if (tab !== activeTab) onSelectTab(tab) }}>{children}</MenuItem>
}
