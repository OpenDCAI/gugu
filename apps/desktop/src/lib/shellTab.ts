import { createContext, useContext, useSyncExternalStore } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

// @@@shell-tab-store — which top-level surface (消息 / 联系人 / 设置 …) is shown. One store per main layout,
// outside React state: a switch must cost O(1) renders. A surface asks only "am I shown?" (useShellTabIs),
// so flipping tabs re-renders the two surfaces whose answer changed, never the hidden trees behind them.
// ❌ Thread the tab down as a prop again: every prop change re-renders the whole retained surface.
export type ShellTabStore = {
  get(): SidebarTab
  set(tab: SidebarTab): void
  subscribe(listener: () => void): () => void
}

export function createShellTabStore(initial: SidebarTab): ShellTabStore {
  let tab = initial
  const listeners = new Set<() => void>()
  return {
    get: () => tab,
    set(next) {
      if (next === tab) return
      tab = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const ShellTabContext = createContext<ShellTabStore | null>(null)

export function useShellTabStore(): ShellTabStore {
  const store = useContext(ShellTabContext)
  if (!store) throw new Error('useShellTab* is used outside the main layout (no ShellTabContext)')
  return store
}

export function useShellTabOf(store: ShellTabStore): SidebarTab {
  return useSyncExternalStore(store.subscribe, store.get)
}

export function useShellTab(): SidebarTab {
  return useShellTabOf(useShellTabStore())
}

export function useShellTabIs(tab: SidebarTab): boolean {
  const store = useShellTabStore()
  return useSyncExternalStore(store.subscribe, () => store.get() === tab)
}

/** The shown tab if it is one of `tabs`, else null: re-renders only when the answer changes. `[]` never re-renders. */
export function useShellTabAmong(tabs: readonly SidebarTab[]): SidebarTab | null {
  // An empty set is "this surface does not depend on the shell tab": it needs no store (it may live in another root).
  const store = useContext(ShellTabContext)
  if (!store && tabs.length) throw new Error('useShellTabAmong is used outside the main layout (no ShellTabContext)')
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, () => { const tab = store?.get(); return tab && tabs.includes(tab) ? tab : null })
}

const subscribeNothing = () => () => {}
