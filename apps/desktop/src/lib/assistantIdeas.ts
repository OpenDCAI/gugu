// #7199 「灵感」入口:输入框上方那颗「灵感」胶囊能隐藏,隐藏后「+」里的「获取灵感」照样在。
// 隐藏与否记在这台设备上(按设备 + 账号记、不同步);壳(「+」菜单)与会话页(胶囊、灵感面板)是同一个 document,
// localStorage 两边共读一份,改了发一个 window 事件。「+」里点「获取灵感」= 发一个打开面板的 window 事件,面板那一侧听。
import { useSyncExternalStore } from 'react'

const KEY_PREFIX = 'gugu.assistant.ideasEntry:'
const PREF_EVENT = 'gugu:assistant-ideas-pref'
const OPEN_EVENT = 'gugu:assistant-ideas-open'

export function ideasEntryHidden(assistantId: string): boolean {
  try {
    return localStorage.getItem(KEY_PREFIX + assistantId) === 'hidden'
  } catch {
    return false
  }
}

export function setIdeasEntryHidden(assistantId: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(KEY_PREFIX + assistantId, 'hidden')
    else localStorage.removeItem(KEY_PREFIX + assistantId)
  } catch {
    // 记不住就照默认(露着)。
  }
  window.dispatchEvent(new Event(PREF_EVENT))
}

function subscribePref(listener: () => void): () => void {
  window.addEventListener(PREF_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(PREF_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useIdeasEntryHidden(assistantId: string): boolean {
  return useSyncExternalStore(subscribePref, () => ideasEntryHidden(assistantId))
}

/** 「+」→「获取灵感」:请面板那一侧打开。 */
export function requestIdeas(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function subscribeIdeasRequest(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener)
  return () => window.removeEventListener(OPEN_EVENT, listener)
}
