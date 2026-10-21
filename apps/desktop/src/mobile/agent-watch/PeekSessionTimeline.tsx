import { useDevicesStore } from '../../store/devicesContext'
import { listedSession, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { SessionTimelinePage } from './SessionTimelinePage'

/**
 * G1 on the phone: a session beside an App (`showSession(id, { peek: true })`) is its timeline over the App's frame — the
 * page the task tab opens for its row, found the way that row is (`listedSession`), its back the peek's.
 */
export function PeekSessionTimeline({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { devices } = useDevicesStore()
  const listed = listedSession(devices, useLiveDeviceSessions(), sessionId)
  const device = 'row' in listed ? devices.find((one) => one.device_id === listed.row.deviceId) : undefined
  if (!('row' in listed) || !device) return null
  return <SessionTimelinePage device={device} session={listed.row.session} onBack={onBack} />
}
