// #7199「快速聊天」:全局快捷键在任何地方叫出一扇和个人助理聊天的小窗。渲染层 ↔ 主进程的契约,只此一份。
//
// 小窗是主窗渲染进程开的一扇同源子窗(window.open,名字见下),界面由主窗那边的 React 画进去 —— 同一份登录、数据、实时,
// ❌ 另起一个咕咕(electron/aux-window.ts)。快捷键、显隐、位置归主进程(electron/quick-chat-window.ts)。

/** 小窗的 window.open 名字:带子窗前缀(主进程照子窗放行),这一个名字配小窗的外观。 */
export const QUICK_CHAT_WINDOW_NAME = 'gugu-aux:quick-chat'

export const QUICK_CHAT_CHANNELS = {
  /** 快捷键此刻的样子(invoke,回 QuickChatState)。 */
  state: 'quick-chat:state',
  /** 开 / 关快捷键(invoke,boolean → QuickChatState)。记在这台电脑上。 */
  setEnabled: 'quick-chat:set-enabled',
  /** 收起小窗(invoke):关闭钮、发完想走。 */
  hide: 'quick-chat:hide',
  /** 收起小窗、把主窗叫到前面(invoke):「打开咕咕」。 */
  openMain: 'quick-chat:open-main',
  /** 主进程 → 主窗:按了快捷键而小窗还没开(或被关掉了),开一扇;开好主进程就把它摆出来(event)。 */
  open: 'quick-chat:open',
  /** 主进程 → 主窗:小窗摆出来 / 收起了(event,boolean)。 */
  visibility: 'quick-chat:visibility',
  /** 主进程 → 渲染层:快捷键状态变了(event,不带内容,收到再要一次 state)。 */
  changed: 'quick-chat:changed',
} as const

export type QuickChatState = {
  /** 这台电脑能注册全局快捷键(桌面版、不是 server 模式)。 */
  supported: boolean
  enabled: boolean
  /** Electron 写法(Alt+Shift+Space)。 */
  accelerator: string
  /** 开着却没注册上 = 被别的应用占了(或系统不让);❌ 假装生效。 */
  registered: boolean
}

/**
 * 默认快捷键:mac ⌥⇧Space(⌘Space 聚焦搜索、⌃Space / ⌃⌥Space 切输入法、⌥Space 是 ChatGPT / Raycast / Alfred 的默认,都不碰);
 * Windows / Linux Ctrl+Alt+Space(Alt+Space 是系统窗口菜单、Ctrl+Space / Shift+Space / Win+Space 是输入法)。
 */
export function quickChatAccelerator(platform: string): string {
  return platform === 'darwin' ? 'Alt+Shift+Space' : 'Control+Alt+Space'
}

/** 给人看的那一串:mac 用符号(⌥⇧Space),别的平台用字(Ctrl+Alt+Space)。 */
export function shortcutLabel(accelerator: string, platform: string): string {
  const parts = accelerator.split('+')
  if (platform === 'darwin') {
    const symbol: Record<string, string> = { Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
    return parts.map((part) => symbol[part] ?? part).join('')
  }
  const word: Record<string, string> = { Control: 'Ctrl', CommandOrControl: 'Ctrl', Super: 'Win', Meta: 'Win' }
  return parts.map((part) => word[part] ?? part).join('+')
}
