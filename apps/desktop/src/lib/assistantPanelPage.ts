import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'

export type AssistantPanelPage = { key: string; back: () => void }
type PageStore = { get: () => AssistantPanelPage | null; subscribe: (fn: () => void) => () => void; open: (page: AssistantPanelPage) => () => void }
const KEY = '__GUGU_ASSISTANT_PANEL_PAGE__'

/** Portal content and the panel toolbar belong to separate React roots. */
function pageStore(): PageStore {
  const target = window as Window & { [KEY]?: PageStore }
  if (target[KEY]) return target[KEY]
  let current: AssistantPanelPage | null = null
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  return target[KEY] = {
    get: () => current,
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } },
    open: page => {
      current = page; publish()
      return () => { if (current === page) { current = null; publish() } }
    },
  }
}

export function useAssistantPanelPage() {
  const store = pageStore()
  return useSyncExternalStore(store.subscribe, store.get)
}

/** Only panel content opts in; standalone settings retain their own navigation. */
export function useAssistantPanelBack(key: string | null, back: () => void) {
  const latest = useRef(back)
  latest.current = back
  useLayoutEffect(() => key ? pageStore().open({ key, back: () => latest.current() }) : undefined, [key])
}
