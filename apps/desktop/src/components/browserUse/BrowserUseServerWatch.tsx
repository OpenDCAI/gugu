import { observer } from 'mobx-react-lite'
import { useEffect, useRef } from 'react'
import { fetchCloudBrowserStatus } from '@/lib/browserUseLink'
import { cloudHostSuspended } from '@/lib/cloudHostSuspended'
import { rendererLogger } from '@/lib/log'
import { useSessionHostAsk } from '@/session/renderer/features/extensions/use-session-host-ask'
import { autoOpenBrowserUseTab } from './browserUseAutoOpenRules'
import { browserUseMachine } from './browserUsePlace'

const log = rendererLogger('browser-use/auto-open')

/** 任务开着时多久问一次那台 server 的浏览器开没开(只为「开了」那一刻;画面在页签里另问)。 */
const WATCH_POLL_MS = 10_000

/**
 * 一个开着的任务在咕咕 server 上跑、它用的那台机器的浏览器开始干活时 —— 浏览器从没开到开了,或这个任务来了一问
 * 「请你登录 / 接手」—— 把 Browser Use 页签加到它的页签条上(autoOpenBrowserUseTab)。不画任何东西。
 * 由 BrowserUseAutoOpen 按需载入(它拖着设备 RPC 那一串,会话页的模块图里 ❌ 静态引它)。
 */
const BrowserUseServerWatch = observer(function BrowserUseServerWatch({ sessionId }: { sessionId: string }) {
  const machine = browserUseMachine(sessionId)
  if (machine.kind !== 'server' || !machine.online) return null
  return <ServerWatch key={machine.deviceId} sessionId={sessionId} deviceId={machine.deviceId} />
})
export default BrowserUseServerWatch

function ServerWatch({ sessionId, deviceId }: { sessionId: string; deviceId: string }) {
  const ask = useSessionHostAsk(sessionId, 'browser-assistance', { rereadMs: WATCH_POLL_MS })
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
}
