import { useMemo, useRef } from 'react'
import { replaceEqualDeep } from '@tanstack/react-query'
import { shareRows } from '@/lib/chatProjectionAlgebra'
import { memoizeByReference } from '@/lib/memoizeByReference'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useMobileShell } from '@/hooks/useMobileShell'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

const EMPTY_SESSIONS: readonly SessionpageSessionSummary[] = []

/** Ordinary replies keep their native journal; explicit owner notifications also light the numeric badge. */
export function useNativeAgentChats(chats: readonly ChatItem[]): ChatItem[] {
  const directory = useLiveDeviceSessions()
  const devices = useDirectoryDevices()
  useOwnedAgentEntries()
  const mobile = useMobileShell()
  const previousBuckets = useRef<Record<string, SessionpageSessionSummary[]>>({})
  // Group the directory once; unchanged buckets remain the same projection dependency.
  const sessionsByAgent = useMemo(() => {
    const byAgent: Record<string, SessionpageSessionSummary[]> = {}
    for (const row of directoryRows(devices, directory)) {
      const agentUserId = row.session.agent?.userId
      if (!agentUserId) continue
      ;(byAgent[agentUserId] ??= []).push(row.session)
    }
    for (const bucket of Object.values(byAgent)) {
      bucket.sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    }
    return previousBuckets.current = replaceEqualDeep(previousBuckets.current, byAgent)
  }, [devices, directory])
  const project = useMemo(() => memoizeByReference((chat: ChatItem, sessions: readonly SessionpageSessionSummary[] | null): ChatItem => {
    if (sessions === null) return chat
    // Several conversations can belong to the same agent; the latest reply can be in an older task.
    const last = sessions.reduce<SessionpageSessionSummary['nativeLastMessage']>((latest, session) => {
      const candidate = session.nativeLastMessage
      return candidate && (!latest || Date.parse(candidate.at) > Date.parse(latest.at)) ? candidate : latest
    }, undefined)
    const notifications = sessions[0]?.nativeOwnerNotificationUnreadCount ?? 0
    const withNotifications = notifications ? { ...chat, unread_count: chat.unread_count + notifications } : chat
    const newer = last && Date.parse(last.at) > (chat.last_message_at ? Date.parse(chat.last_message_at) : 0)
    // Its machine away, only its heartbeat summary is here: no last message, but the task is still there. On the phone the
    // row stays, placed by when the task was last used: it is the way in, and that page says the machine is away.
    // ❌ On a computer: its session page waits for that machine without a word, so the row would do nothing when clicked.
    const seen = mobile && sessions[0] && last === undefined && !chat.last_message_at ? sessions[0].lastInteractedAt : undefined
    return newer ? { ...withNotifications, last_message_preview: last.text, last_message_at: last.at, last_message_failure: null } : seen ? { ...withNotifications, last_message_at: seen } : withNotifications
  }), [mobile])
  const shared = useRef<ChatItem[]>([])
  shared.current = shareRows(shared.current, chats.map(chat => project(chat,
    (chat.kind === 'dm' || chat.kind === 'ai') && isOwnedAgentPeer(chat.peer_user_id)
      ? sessionsByAgent[chat.peer_user_id ?? ''] ?? EMPTY_SESSIONS : null)))
  return shared.current
}
