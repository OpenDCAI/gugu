import { useEffect, useMemo, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { deliveryWaits, pendingDeliveryMessageIds, type HeldMessage } from '@gugu/core/shared/ui/systemNotice'
import { loadMessageAgentWakes } from '@/lib/chatMessageRevalidation'

const NO_WAKES: ReadonlyMap<string, ReadonlySet<string>> = new Map()

/** My messages an agent has not taken yet: their bubbles say so until it reads them. */
export function useDeliveryWaits(messages: readonly MessageItem[], memberReadSeqs: Record<string, number>): ReadonlyMap<string, HeldMessage> {
  const lookup = useMemo(() => pendingDeliveryMessageIds(messages, memberReadSeqs).join(','), [messages, memberReadSeqs])
  const [wakes, setWakes] = useState(NO_WAKES)
  useEffect(() => {
    if (!lookup) return
    let alive = true
    void loadMessageAgentWakes(lookup.split(',')).then((loaded) => { if (alive) setWakes(loaded) })
    return () => { alive = false }
  }, [lookup])
  return useMemo(() => deliveryWaits(messages, memberReadSeqs, wakes), [messages, memberReadSeqs, wakes])
}
