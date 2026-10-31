import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'

export type AssistantPanelPage = { key: string; back: () => void }
type PageStore = { get: () => AssistantPanelPage | null; subscribe: (fn: () => void) => () => void; open: (page: AssistantPanelPage, priority: number) => () => void }
const KEY = '__GUGU_ASSISTANT_PANEL_PAGE__'

/** Portal content and the panel toolbar belong to separate React roots. */
function pageStore(): PageStore {
  const target = window as Window & { [KEY]?: PageStore }
  if (target[KEY]) return target[KEY]
  let current: AssistantPanelPage | null = null
  const pages: { page: AssistantPanelPage; priority: number }[] = []
  const listeners = new Set<() => void>()
  const publish = () => {
    const active = pages.reduce<(typeof pages)[number] | null>((selected, entry) => !selected || entry.priority >= selected.priority ? entry : selected, null)?.page ?? null
    if (active === current) return
    current = active
    for (const listener of listeners) listener()
  }
  return target[KEY] = {
    get: () => current,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    open: (page, priority) => {
      const entry = { page, priority }
      pages.push(entry); publish()
      return () => { pages.splice(pages.indexOf(entry), 1); publish() }
    },
  }
}

export function useAssistantPanelPage() {
  const store = pageStore()
  return useSyncExternalStore(store.subscribe, store.get)
}

/** Only panel content opts in; standalone settings retain their own navigation. */
export function useAssistantPanelBack(key: string | null, back: () => void, priority = 1) {
  const latest = useRef(back)
  latest.current = back
  useLayoutEffect(() => key ? pageStore().open({ key, back: () => latest.current() }, priority) : undefined, [key, priority])
}
