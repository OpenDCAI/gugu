import { useEffect } from 'react'
import { installAgentStatusFeedBridge } from '../lib/agentStatusFeedBridge'

/**
 * 宿主按 agent 的流在组件树里的**挂钩**,不是属主本身:属主是 app 级单例。这个组件只做一件事 ——
 * 在 app 起来时把它接上。
 */
export function AgentStatusFeedBridge() {
  useEffect(() => { installAgentStatusFeedBridge() }, [])
  return null
}
