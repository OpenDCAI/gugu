import { useCallback, useEffect, useState } from 'react'

// @@@6418 群聊设置抽屉 = 一个页面栈。成员相关的一切(看、找、邀请、改角色、移出、倾听模式)归群成员面板(与 👥 同一个
// MemberListPanel),一级页只留一行入口 ⇒ 不再有第二份名单(#2178 的头像网格)与第二套成员操作。一级页:群资料 / 成员入口 /
// 公告·规则·描述 / 聊天(查找·通知·置顶·清空,与单聊同一份) / 群管理入口 / 离开·解散。群成员、群公告、群管理(仅群主/管理员)、
// 规则、描述各是一页,页头同一个、返回回一级页。所有改动即时生效,没有底部「保存」。
export type SettingsPage = 'main' | 'members' | 'announcement' | 'manage' | 'rules' | 'description'

/**
 * The group info's page stack. Opened at `initialPage` (the members' button: their list), its back is the first page;
 * another chat, or another open of the tab (the caller keys it), starts over.
 */
export function useSettingsPages(chatId: string, initialPage?: 'main' | 'members' | 'announcement') {
  const [pages, setPages] = useState<SettingsPage[]>(() => (initialPage && initialPage !== 'main' ? ['main', initialPage] : ['main']))
  const push = useCallback((next: SettingsPage) => setPages((stack) => [...stack, next]), [])
  const pop = useCallback(() => setPages((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack)), [])
  useEffect(() => { setPages(initialPage && initialPage !== 'main' ? ['main', initialPage] : ['main']) }, [chatId, initialPage])
  return { page: pages[pages.length - 1], push, pop }
}
