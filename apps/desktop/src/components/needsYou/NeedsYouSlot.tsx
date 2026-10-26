import { useCallback, useId } from 'react'
import { readShellSlots } from '@/lib/shellSlots'

export const NEEDS_YOU_SLOT_PREFIX = 'needs-you:'

/** Keep the shared entry in each composer's existing layout, including embedded task roots. */
export function NeedsYouSlot() {
  const id = useId()
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(`${NEEDS_YOU_SLOT_PREFIX}${id}`, element), [id])
  return <div ref={ref} data-needs-you-slot="" className="flex shrink-0 items-center justify-end pointer-events-auto [&:not(:empty)]:py-1" />
}
