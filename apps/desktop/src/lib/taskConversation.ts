import { useConversationSessionSummary } from '@/hooks/useConversationSessionSummary'
import { listedSession, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/**
 * The conversation a session's tab is in (`AppWhere.conversation`): the person's private chat with that session's agent, as
 * the session's own row says it (`SessionpageSessionSummary.chatId`, from the roster of the machine it is on) — the chat an
 * App there is in (`getContext().chat`), on the desktop and the phone alike. Null for a session whose agent has no identity
 * yet (its private chat is made when it is provisioned).
 */
export function useTaskConversation(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  return useConversationSessionSummary(sessionId ?? undefined, deviceId)?.chatId ?? null
}

/** The task's project group, for Files' chat root. Other Apps keep the task's private conversation. */
export function useTaskProjectChat(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  const devices = useDirectoryDevices()
  const live = useLiveDeviceSessions()
  const listed = sessionId ? listedSession(deviceId ? devices.filter((device) => device.device_id === deviceId) : devices, live, sessionId) : null
  if (!listed || !('row' in listed)) return null
  const { row } = listed
  return devices.find((device) => device.device_id === row.deviceId)?.projects
    ?.find((project) => project.localProjectId === row.session.projectId)?.chatId ?? null
}
