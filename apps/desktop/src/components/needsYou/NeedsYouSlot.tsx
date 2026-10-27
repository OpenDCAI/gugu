import { useCallback, useId } from 'react'
import { readShellSlots } from '@/lib/shellSlots'

export const NEEDS_YOU_SLOT_PREFIX = 'needs-you:'
export const NEEDS_YOU_LIST_SLOT_PREFIX = 'needs-you-list:'

/** Keep the shared entry in each composer's existing layout, including embedded task roots. */
export function NeedsYouSlot({ list = false }: { list?: boolean }) {
  const id = useId()
  const prefix = list ? NEEDS_YOU_LIST_SLOT_PREFIX : NEEDS_YOU_SLOT_PREFIX
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(`${prefix}${id}`, element), [id, prefix])
  return <div ref={ref} data-needs-you-slot={list ? undefined : ''} data-needs-you-list-slot={list ? '' : undefined} className={list ? undefined : "flex shrink-0 items-center justify-end pointer-events-auto [&:not(:empty)]:py-1"} />
}
