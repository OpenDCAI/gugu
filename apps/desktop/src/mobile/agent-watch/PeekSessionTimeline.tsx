import type { ReactNode } from 'react'
import { useDevicesStore } from '../../store/devicesContext'
import { listedSession, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { SessionTimelinePage } from './SessionTimelinePage'

/**
 * G1 on the phone: a session beside an App (`showSession(id, { peek: true })`) is its timeline over the App's frame — the
 * page the task tab opens for its row, found the way that row is (`listedSession`), its back the peek's.
 */
export function PeekSessionTimeline({ sessionId, local, nativeOnly = false, fallback = null, onBack }: {
  sessionId: string; local?: boolean; nativeOnly?: boolean; fallback?: ReactNode; onBack: () => void
}) {
  const { devices } = useDevicesStore()
  const listed = listedSession(devices, useLiveDeviceSessions(), sessionId)
  const device = 'row' in listed ? devices.find((one) => one.device_id === listed.row.deviceId) : undefined
  if (!('row' in listed) || !device || (nativeOnly && listed.row.session.nativeInputVersion !== 1 && listed.row.session.nativeInputVersion !== 2)) return fallback
  return <SessionTimelinePage device={device} session={listed.row.session} local={local} onBack={onBack} />
}
