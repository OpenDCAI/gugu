import { useEffect, useSyncExternalStore } from 'react'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { parseAgentLook, type AgentLook } from './look'
import { agentIdentity } from './engine/identity'

const noop = () => () => {}

/**
 * 这只 agent 在本地身份缓存里的头像字段;缓存里没有这个人 = undefined(没有桥 / 没登录同理)。
 * 读的是聊天页那一份身份缓存本身(identityDirectoryBridge,会话页与聊天页同一个 document),❌ 另建缓存。
 */
function useDirectoryAvatar(id: string): string | null | undefined {
  const bridge = readIdentityDirectoryBridge()
  const avatar = useSyncExternalStore(
    bridge ? bridge.subscribe : noop,
    () => {
      const row = id ? bridge?.getSnapshot()?.[id] : undefined
      return row ? (row.avatar ?? null) : undefined
    },
    () => undefined,
  )
  const missing = !!bridge && !!id && avatar === undefined && bridge.getSnapshot() != null
  useEffect(() => {
    // 缓存里还没有这只 agent(会话页的行、手机的任务行只知道 id)→ 交给缓存按需补取,补到后经订阅重读。
    if (missing) bridge?.ensure([id])
  }, [bridge, id, missing])
  return avatar
}

/**
 * 小鸟该长什么样。优先级:调用方明确给的形象(形象工坊的草稿、没开户会话按会话 id 推的)→ 身份缓存里这只 agent
 * 存着的形象(最新的那一份)→ 调用方手里的头像地址(缓存里还没有这个人时)→ 按 id 推出来的样子。
 */
export function useAgentLook(id: string, explicit?: AgentLook | null, knownAvatar?: string | null): AgentLook {
  // 给了形象就不去缓存里找(那一格的 id 可能根本不是用户 id,比如形象工坊的表情样片、没开户的会话):❌ 为它去补取身份。
  const cached = useDirectoryAvatar(explicit ? '' : id)
  const stored = parseAgentLook(cached !== undefined ? cached : knownAvatar)
  return explicit ?? stored ?? agentIdentity(id)
}
