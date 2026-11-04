import { memo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { OFFLINE_SESSION_SLOT_PREFIX, installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { readSessionpageHistory } from '@/lib/sessionpageHistoryBridge'
import { PeekSessionTimeline } from '@/mobile/agent-watch/PeekSessionTimeline'
import { OfflineSessionInput } from './OfflineSessionInput'

installShellSlots()
const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/** The gate owns eligibility; Peek alone chooses the timeline or original input from its directory row. */
export const OfflineSessionSlotHost = memo(function OfflineSessionSlotHost() {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    listener => slots?.subscribeSlots(listener) ?? (() => {}),
    () => slots?.getSlots() ?? EMPTY,
  )
  return <>{[...entries].flatMap(([key, element]) => {
    if (!key.startsWith(OFFLINE_SESSION_SLOT_PREFIX)) return []
    const [sessionId, deviceId] = key.slice(OFFLINE_SESSION_SLOT_PREFIX.length).split('/').map(decodeURIComponent)
    const label = slots?.getSlotLabel?.(key) ?? ''
    return [createPortal(<div className="ta-skin flex h-full min-h-0 w-full flex-col">
      <PeekSessionTimeline sessionId={sessionId} nativeOnly
        fallback={<OfflineSessionInput deviceId={deviceId} sessionId={sessionId} label={label} />}
        onBack={() => readSessionpageHistory()?.back()} />
    </div>, element, key)]
  })}</>
})
