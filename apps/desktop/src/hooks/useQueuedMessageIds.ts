import { useEffect, useMemo, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { pendingDeliveryMessageIds, queuedMessageIds } from '@gugu/core/shared/ui/systemNotice'
import { loadMessageAgentWakes } from '@/lib/chatMessageRevalidation'

const NO_WAKES: ReadonlyMap<string, ReadonlySet<string>> = new Map()

/** My messages an agent has not taken yet: they show 「发送中」 on the bubble until it reads them. */
export function useQueuedMessageIds(messages: readonly MessageItem[], memberReadSeqs: Record<string, number>): ReadonlySet<string> {
  const lookup = useMemo(() => pendingDeliveryMessageIds(messages, memberReadSeqs).join(','), [messages, memberReadSeqs])
  const [wakes, setWakes] = useState(NO_WAKES)
  useEffect(() => {
    if (!lookup) return
    let alive = true
    void loadMessageAgentWakes(lookup.split(',')).then((loaded) => { if (alive) setWakes(loaded) })
    return () => { alive = false }
  }, [lookup])
  return useMemo(() => queuedMessageIds(messages, memberReadSeqs, wakes), [messages, memberReadSeqs, wakes])
}
