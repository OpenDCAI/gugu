import { NAV_COLUMN_MAX_WIDTH, NAV_COLUMN_MIN_WIDTH, NAV_COLUMN_WIDTH } from '@/lib/uiRuler'

// @@@ui-ruler 会话列表默认宽 = 通讯录导航列宽(--nav-col-w):切 tab 时分隔线不再左右跳。
const CHAT_LIST_PANE_STORAGE_KEY = 'gugu.chatListPane.width'
export const CHAT_LIST_PANE_DEFAULT_WIDTH = NAV_COLUMN_WIDTH
export const CHAT_LIST_PANE_MIN_WIDTH = NAV_COLUMN_MIN_WIDTH
export const CHAT_LIST_PANE_MAX_WIDTH = NAV_COLUMN_MAX_WIDTH
export const CHAT_CONTENT_WITH_RIGHT_PANEL_MIN_WIDTH = 740

export function clampChatListPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_LIST_PANE_DEFAULT_WIDTH
  return Math.min(CHAT_LIST_PANE_MAX_WIDTH, Math.max(CHAT_LIST_PANE_MIN_WIDTH, Math.round(width)))
}

export function maxChatListPaneWidthForAvailableWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return CHAT_LIST_PANE_MAX_WIDTH
  const remaining = Math.floor(availableWidth - CHAT_CONTENT_WITH_RIGHT_PANEL_MIN_WIDTH)
  return Math.min(CHAT_LIST_PANE_MAX_WIDTH, Math.max(CHAT_LIST_PANE_MIN_WIDTH, remaining))
}

export function readStoredChatListPaneWidth(storage: Storage = window.localStorage): number {
  const value = Number(storage.getItem(CHAT_LIST_PANE_STORAGE_KEY))
  if (!Number.isFinite(value) || value <= 0) return CHAT_LIST_PANE_DEFAULT_WIDTH
  return clampChatListPaneWidth(value)
}

export function writeStoredChatListPaneWidth(width: number, storage: Storage = window.localStorage): void {
  storage.setItem(CHAT_LIST_PANE_STORAGE_KEY, String(clampChatListPaneWidth(width)))
}
