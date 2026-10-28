import { runInAction } from 'mobx'
import { browserUseTab } from './browserUseApp'
import { taskView } from './browserUsePlace'

const MEMORY_KEY = 'gugu.browserUse.autoOpened'
const MEMORY_CAP = 200

export type AutoOpenMemory = { has(sessionId: string): boolean; add(sessionId: string): void }

function readMemory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 哪些任务已经替人开过一次 Browser Use 页签:人关掉了就不再开(重启也记得)。 */
export const autoOpenMemory: AutoOpenMemory = {
  has: (sessionId) => readMemory().includes(sessionId),
  add: (sessionId) => {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify([...readMemory().filter((id) => id !== sessionId), sessionId].slice(-MEMORY_CAP)))
    } catch {
      // 记不住:这次照样开了,下次最多再开一次
    }
  },
}

/**
 * 替这个任务把 Browser Use 页签加到页签条上一次,❌ 抢焦点(开在对话旁边、不切过去,同 agent 打开的页)。
 * 只在这台电脑上装着并启用了 Browser Use 时;每个任务一次:开过(或人自己开着)就记下,人关掉了不再开。
 * 开了 = true。
 */
export function autoOpenBrowserUseTab(sessionId: string, memory: AutoOpenMemory = autoOpenMemory): boolean {
  if (memory.has(sessionId)) return false
  const { state, tab } = browserUseTab()
  if (state !== 'ready' || !tab) return false
  const view = taskView(sessionId)
  if (!view) return false
  memory.add(sessionId)
  const shown = [...view.paneLayout.groups.map((group) => group.pane), ...[...view.paneLayout.windowPanes.values()].map((w) => w.pane)]
    .some((pane) => pane.resolvedTabs.some((entry) => entry.kind === tab.kind))
  if (shown) return false
  runInAction(() => view.paneLayout.open(tab.kind, {}, { preview: false, beside: true, activate: false }))
  return true
}
