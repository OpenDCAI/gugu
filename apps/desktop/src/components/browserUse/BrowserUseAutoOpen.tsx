import { observer } from 'mobx-react-lite'
import { lazy, Suspense } from 'react'
import { browserUseTab } from './browserUseApp'

// 看那台 server 的浏览器要设备 RPC(deviceRpc → supabase,模块载入就碰 window):Browser Use 启用了才载入,
// 会话页的模块图(和它在 node 里跑的测试)不因这一格拖进它们。
const BrowserUseServerWatch = lazy(() => import('./BrowserUseServerWatch'))

/**
 * 任务在咕咕 server 上、它的浏览器开始干活:Browser Use 页签替人加到页签条上一次(不切过去;BrowserUseServerWatch)。
 * 没装 / 停用了 Browser Use:什么都不看,也不载入那一串。
 */
export const BrowserUseAutoOpen = observer(function BrowserUseAutoOpen({ sessionId }: { sessionId: string }) {
  if (browserUseTab().state !== 'ready') return null
  return (
    <Suspense fallback={null}>
      <BrowserUseServerWatch sessionId={sessionId} />
    </Suspense>
  )
})
