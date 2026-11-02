import { memo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { OFFLINE_SESSION_SLOT_PREFIX, installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { readSessionpageHistory } from '@/lib/sessionpageHistoryBridge'
import { PeekSessionTimeline } from '@/mobile/agent-watch/PeekSessionTimeline'

installShellSlots()
const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/** No eligibility policy here: the session content gate registers only its offline native branch. */
export const OfflineSessionSlotHost = memo(function OfflineSessionSlotHost() {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    listener => slots?.subscribeSlots(listener) ?? (() => {}),
    () => slots?.getSlots() ?? EMPTY,
  )
  return <>{[...entries].flatMap(([key, element]) => {
    if (!key.startsWith(OFFLINE_SESSION_SLOT_PREFIX)) return []
    const sessionId = key.slice(OFFLINE_SESSION_SLOT_PREFIX.length).split('/')[0]
    return [createPortal(<div className="ta-skin flex h-full min-h-0 w-full flex-col">
      <PeekSessionTimeline sessionId={sessionId} onBack={() => readSessionpageHistory()?.back()} />
    </div>, element, key)]
  })}</>
})
