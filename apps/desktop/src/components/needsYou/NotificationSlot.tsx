import { useCallback, useId } from 'react'
import { readShellSlots } from '@/lib/shellSlots'

export const NOTIFICATION_TOGGLE_SLOT_PREFIX = 'notification-toggle:'
export const NOTIFICATION_LIST_SLOT_PREFIX = 'notification-list:'

/** The account shell renders the same global notifications into desktop and phone list slots. */
export function NotificationSlot({ part, active = true }: { part: 'toggle' | 'list'; active?: boolean }) {
  const id = useId()
  const key = `${part === 'toggle' ? NOTIFICATION_TOGGLE_SLOT_PREFIX : NOTIFICATION_LIST_SLOT_PREFIX}${id}`
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(key, element, active ? 'active' : 'inactive'), [key, active])
  return <div ref={ref} data-notification-slot={part} hidden={!active} className={!active ? 'hidden' : part === 'list' ? 'flex min-h-0 flex-1 flex-col' : 'flex items-center'} />
}
