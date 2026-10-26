// 'assistant'(#7199 个人助理)只在手机壳里有:桌面上它是最左栏那一格打开的会话页视图(在 'tasks' 底下),❌ 进这个列表。
export type SidebarTab = 'assistant' | 'tasks' | 'chats' | 'contacts' | 'settings'

export const SIDEBAR_TABS: SidebarTab[] = ['tasks', 'chats', 'contacts', 'settings']

/**
 * 手机底栏的格子(横滑分页器同一份顺序):「消息 / 伙伴」两格,只在这两张列表首页(owner 10-26,OpenDCAI/gugu#446)。
 * 'assistant'(「消息」置顶第一行)、'tasks'、'settings'(页头左上自己的头像)在手机上是整屏推进来的一层,没有底栏。
 */
export const MOBILE_TABS: SidebarTab[] = ['chats', 'contacts']
