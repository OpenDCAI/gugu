import { useMemo, useRef } from 'react'
import { shareRows } from '@/lib/chatProjectionAlgebra'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useMobileShell } from '@/hooks/useMobileShell'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

/** Ordinary replies keep their native journal; explicit owner notifications also light the numeric badge. */
export function useNativeAgentChats(chats: readonly ChatItem[]): ChatItem[] {
  const directory = useLiveDeviceSessions()
  const devices = useDirectoryDevices()
  useOwnedAgentEntries()
  const mobile = useMobileShell()
  const previousBuckets = useRef(new Map<string, SessionpageSessionSummary[]>())
  // 目录里的会话**一次**扫出来,按 agent 分好组。
  //
  // 原来每一行 agent 私聊都重扫一遍整个目录(`directoryRows(devices, directory)` 在 map 里面),
  // 于是这一段是「会话数 × 目录里的会话数」—— 机器多、任务多的时候,列表每渲染一次就要重算
  // 几百上千遍同一份目录。现在只扫一次。
  const sessionsByAgent = useMemo(() => {
    const byAgent = new Map<string, SessionpageSessionSummary[]>()
    for (const row of directoryRows(devices, directory)) {
      const agentUserId = row.session.agent?.userId
      if (!agentUserId) continue
      const bucket = byAgent.get(agentUserId)
      if (bucket) bucket.push(row.session)
      else byAgent.set(agentUserId, [row.session])
    }
    for (const bucket of byAgent.values()) {
      bucket.sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    }
    for (const [id, bucket] of byAgent) {
      const previous = previousBuckets.current.get(id)
      if (previous && previous.length === bucket.length && bucket.every((session, index) => session === previous[index])) byAgent.set(id, previous)
    }
    previousBuckets.current = byAgent
    return byAgent
  }, [devices, directory])
  const sessionsRef = useRef(sessionsByAgent)
  sessionsRef.current = sessionsByAgent
  const project = useMemo(() => {
    const cache = new WeakMap<ChatItem, { owned: boolean; sessions: SessionpageSessionSummary[] | undefined; row: ChatItem }>()
    return (chat: ChatItem): ChatItem => {
      const owned = (chat.kind === 'dm' || chat.kind === 'ai') && isOwnedAgentPeer(chat.peer_user_id)
      const sessions = owned ? sessionsRef.current.get(chat.peer_user_id ?? '') : undefined
      const previous = cache.get(chat)
      if (previous?.owned === owned && previous.sessions === sessions) return previous.row
      const row = owned ? projectOwned(chat, sessions ?? []) : chat
      cache.set(chat, { owned, sessions, row })
      return row
    }
    function projectOwned(chat: ChatItem, sessions: SessionpageSessionSummary[]): ChatItem {
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
    }
  }, [mobile])
  const shared = useRef<ChatItem[]>([])
  shared.current = shareRows(shared.current, chats.map(project))
  return shared.current
}
