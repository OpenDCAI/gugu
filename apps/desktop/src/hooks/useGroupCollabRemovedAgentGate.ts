import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { reconcileGroupCollabSnapshot, removeAgentFromGroupCollab } from '../lib/groupCollabSnapshot'
import { UI_EVENTS } from '../lib/uiEvents'

export interface GroupCollabRemovedAgentGate {
  // 过滤掉本会话已删 Agent——用于「从缓存派生名册」的 reseed 落点。
  prune: (snapshot: GroupCollabSnapshot) => GroupCollabSnapshot
  // @@@2247 权威全量 load reconcile 后再 prune。曾是 SWR「永不缩小」merge（防瞬态 partial 闪空）；现改为
  // reconcile（**允许缩小**）——权威 getGroupCollab 是成员真值：chat_members 的 SELECT RLS =
  // `is_member(chat_id)`（chat 级、全有或全无 → 非空读必完整；空/失败读由 getGroupCollab 内部重试+抛错兜住，
  // loadGroupCollab 命中此处时 snapshot 恒完整），故 next 里缺席的成员 = 被移出群、须消失（否则冷启/重开
  // 残留成幽灵，#2247）。名称保留 mergeAndPrune（唯一消费者 = loadGroupCollab 的权威落点；改名会动被
  // #2238/#2223 占用的 ChatAreaPanel）。
  mergeAndPrune: (prev: GroupCollabSnapshot, next: GroupCollabSnapshot) => GroupCollabSnapshot
}

// @@@1877 群名册对「已删本机 Agent」的即时乐观收敛闸门（从 ChatAreaPanel 抽出，避免 god-file 增长）。删除后该 Agent
// 永久消失(identity 行已删)；权威 refetch 的收敛已由 #2247 的 reconcile(allow-shrink) + roster true-replace 兜住，
// 但删除事件到、下次权威读未到的即时窗口里，三层缓存(内存 roster / 持久 localSync roster / 内存 snapshot)任一层
// 残留仍会把它显示出来。本 hook 一处封堵全部路径，做即时乐观剔除：
//  ① 订阅 ownedAgentRemoved 事件 → 即时从当前 snapshot + 内存缓存剔除(当前打开的抽屉当下更新);
//  ② 把 id 记入集合并返回 prune()，供 loadGroupCollab 在「从缓存/merge 派生名册」的每个落点统一过滤;
//  ③ 集合随登录用户切换清空——绝不把一个账号的已删名单套到另一个账号。
export function useGroupCollabRemovedAgentGate(
  userId: string | undefined,
  setSnapshot: Dispatch<SetStateAction<GroupCollabSnapshot>>,
  memoryCacheRef: MutableRefObject<Map<string, GroupCollabSnapshot>>,
): GroupCollabRemovedAgentGate {
  const removedIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    removedIdsRef.current = new Set()
  }, [userId])

  useEffect(() => {
    const handleAgentRemoved = (event: Event) => {
      const agentUserId = (event as CustomEvent<{ agentUserId?: string }>).detail?.agentUserId
      if (!agentUserId) return
      removedIdsRef.current.add(agentUserId)
      setSnapshot((prev) => removeAgentFromGroupCollab(prev, agentUserId))
      const cache = memoryCacheRef.current
      for (const [chatId, snapshot] of cache) cache.set(chatId, removeAgentFromGroupCollab(snapshot, agentUserId))
    }
    window.addEventListener(UI_EVENTS.ownedAgentRemoved, handleAgentRemoved)
    return () => window.removeEventListener(UI_EVENTS.ownedAgentRemoved, handleAgentRemoved)
  }, [setSnapshot, memoryCacheRef])

  const prune = useCallback((snapshot: GroupCollabSnapshot): GroupCollabSnapshot => {
    if (removedIdsRef.current.size === 0) return snapshot
    let next = snapshot
    for (const removedId of removedIdsRef.current) next = removeAgentFromGroupCollab(next, removedId)
    return next
  }, [])

  return useMemo<GroupCollabRemovedAgentGate>(() => ({
    prune,
    mergeAndPrune: (prev, next) => prune(reconcileGroupCollabSnapshot(prev, next)),
  }), [prune])
}
