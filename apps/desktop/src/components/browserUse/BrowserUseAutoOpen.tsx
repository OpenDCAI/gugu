import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { useEffect, useRef } from 'react'
import { fetchCloudBrowserStatus } from '@/lib/browserUseLink'
import { cloudHostSuspended } from '@/lib/cloudHostSuspended'
import { rendererLogger } from '@/lib/log'
import { useSessionHostAsk } from '@/session/renderer/features/extensions/use-session-host-ask'
import { browserUseTab } from './browserUseApp'
import { browserUseMachine, taskView } from './browserUsePlace'

const log = rendererLogger('browser-use/auto-open')

/** 任务开着时多久问一次那台 server 的浏览器开没开(只为「开了」那一刻;画面在页签里另问)。 */
const WATCH_POLL_MS = 10_000
const MEMORY_KEY = 'gugu.browserUse.autoOpened'
const MEMORY_CAP = 200

/** 哪些任务已经替人开过一次 Browser Use 页签:人关掉了就不再开(重启也记得)。 */
export const autoOpenMemory = {
  read(): string[] {
    try {
      const raw = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '[]') as unknown
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  },
  has(sessionId: string): boolean {
    return this.read().includes(sessionId)
  },
  add(sessionId: string): void {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify([...this.read().filter((id) => id !== sessionId), sessionId].slice(-MEMORY_CAP)))
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
export function autoOpenBrowserUseTab(sessionId: string, memory = autoOpenMemory): boolean {
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

/**
 * 一个开着的任务在咕咕 server 上跑、它用的那台机器的浏览器开始干活时 —— 浏览器从没开到开了,或这个任务来了一问
 * 「请你登录 / 接手」—— 把 Browser Use 页签加到它的页签条上(autoOpenBrowserUseTab)。不画任何东西。
 */
export const BrowserUseAutoOpen = observer(function BrowserUseAutoOpen({ sessionId }: { sessionId: string }) {
  // 没装 / 停用了 Browser Use:什么都不看(也不去问任务在哪台机器上)。
  if (browserUseTab().state !== 'ready') return null
  const machine = browserUseMachine(sessionId)
  if (machine.kind !== 'server' || !machine.online) return null
  return <ServerWatch key={machine.deviceId} sessionId={sessionId} deviceId={machine.deviceId} />
})

const ServerWatch = observer(function ServerWatch({ sessionId, deviceId }: { sessionId: string; deviceId: string }) {
  const ask = useSessionHostAsk(sessionId, 'browser-assistance')
  useEffect(() => {
    if (ask) autoOpenBrowserUseTab(sessionId)
  }, [ask, sessionId])

  const wasRunning = useRef<boolean | null>(null)
  useEffect(() => {
    wasRunning.current = null
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (!cloudHostSuspended(deviceId)) {
        try {
          const status = await fetchCloudBrowserStatus(deviceId)
          if (cancelled) return
          const running = status.available && status.running
          // 只认「没开 → 开了」这一下:打开任务时它早就开着,不算(那是人自己去开的事)。
          if (wasRunning.current === false && running) autoOpenBrowserUseTab(sessionId)
          wasRunning.current = running
        } catch (error) {
          if (cancelled) return
          log.debug({ deviceId, error: String(error) }, 'browser watch failed')
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), WATCH_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [deviceId, sessionId])
  return null
})
