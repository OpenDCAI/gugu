// 'explore'(发现) 已于 2026-09-05 从联合类型里摘除 —— owner:「发现页离完善还有距离,先不展示」。
// 摘掉而不是留着:留着的话谁再切到 'explore' 会得到一片空白主区(没有任何分支渲染它),
// 那是静默死态;摘掉之后同一个写法直接是编译错误。页面源码仍在 apps/desktop/src/pages/ExplorePage.tsx,
// 恢复入口时把这一项加回来即可。
// 'assistant'(#7199 个人助理)只在手机壳里是一格:桌面上它是最左栏那一格打开的会话页视图(在 'tasks' 底下),❌ 进这个列表。
export type SidebarTab = 'assistant' | 'tasks' | 'chats' | 'contacts' | 'settings'

export const SIDEBAR_TABS: SidebarTab[] = ['tasks', 'chats', 'contacts', 'settings']

/** 手机底栏的格子(横滑分页器同一份顺序):开得了个人助理时它排第一(owner 10-16「助理是咕咕底栏里的一格」)。 */
export function mobileTabs(withAssistant: boolean): SidebarTab[] {
  return withAssistant ? ['assistant', ...SIDEBAR_TABS] : SIDEBAR_TABS
}
