// @@@6470 一条会话线的「对端读到哪了」水位表 —— 主线(store)与话题分栏用同一个容器,线级实时
// (subscribeChatLineRevisions)对两条线一视同仁。
//
// 为什么不是裸 useState:成员进出的事件要在**事件时刻**问「这个人在不在分母里」(新成员 ⇒ 回读一次快照;
// 已在表里的人的行更新 ⇒ 不回读)。useState 的函数式 setter 不保证同步执行,从 setter 里「顺手读一眼」靠不住。
// 所以表的真值在 ref 里:每次写同步落 ref,再交给 React 画。所有写都经这一个 setter,ref 永远是最新的。
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { MemberReadSeqsStore } from '@/lib/accountRevisionListeners'

export function useMemberReadSeqs(): MemberReadSeqsStore & { memberReadSeqs: Record<string, number> } {
  const valueRef = useRef<Record<string, number>>({})
  const [memberReadSeqs, setRendered] = useState(valueRef.current)
  // @@@1529 表属于哪条 chat。同 chat 的快照/补洞要单调 merge(在途旧快照不许把 realtime 已推进的水位回退成未读);
  // 换 chat 要整体替换(同一个 agent 在私聊和群里的水位不许互借)。
  const memberReadSeqsChatRef = useRef<string | null>(null)
  const setMemberReadSeqs = useCallback<Dispatch<SetStateAction<Record<string, number>>>>((action) => {
    const next = typeof action === 'function' ? action(valueRef.current) : action
    if (next === valueRef.current) return
    valueRef.current = next
    setRendered(next)
  }, [])
  const readMemberReadSeqs = useCallback(() => valueRef.current, [])
  return { memberReadSeqs, memberReadSeqsChatRef, setMemberReadSeqs, readMemberReadSeqs }
}
