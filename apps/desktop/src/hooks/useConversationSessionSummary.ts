import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** A task remains identifiable before its live subscription is ready, using the account's device digest. */
export function useConversationSessionSummary(sessionId: string | undefined, deviceId?: string | null) {
  const live = useLiveDeviceSessions()
  const devices = useDirectoryDevices()
  const current = Object.entries(live).flatMap(([id, value]) => value.sessions.map(session => ({ deviceId: id, session })))
  return [...current, ...directoryRows(devices, live)]
    .find(row => row.session.conversationId === sessionId && (!deviceId || row.deviceId === deviceId))?.session
}
