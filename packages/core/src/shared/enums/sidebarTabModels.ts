// 'assistant'(#7199 个人助理)只在手机壳里是一格:桌面上它是最左栏那一格打开的会话页视图(在 'tasks' 底下),❌ 进这个列表。
export type SidebarTab = 'assistant' | 'tasks' | 'chats' | 'contacts' | 'settings'

export const SIDEBAR_TABS: SidebarTab[] = ['tasks', 'chats', 'contacts', 'settings']

/** 手机底栏的格子(横滑分页器同一份顺序):开得了个人助理时它排第一(owner 10-16「助理是咕咕底栏里的一格」)。 */
export function mobileTabs(withAssistant: boolean): SidebarTab[] {
  return withAssistant ? ['assistant', ...SIDEBAR_TABS] : SIDEBAR_TABS
}
