import type { SearchActorScope, SearchDocument, SearchDocumentAccess, SearchHistoryFloor } from './types'
import { searchTimestampMicros as timestamp } from './time.ts'

export interface SearchMembership {
  actorId: string
  chatId: string
  floor: SearchHistoryFloor
}

/** chat.history_floor: the earlier known boundary of direct and source-chat membership. */
export function historyFloor(
  chatId: string,
  sourceChatId: string | null,
  actorId: string,
  memberships: readonly SearchMembership[],
): SearchActorScope | null {
  const rows = memberships.filter((row) => row.actorId === actorId
    && (row.chatId === chatId || (sourceChatId !== null && row.chatId === sourceChatId)))
  if (rows.length === 0) return null
  const known = rows.map((row) => row.floor).filter((floor) => floor.known)
  const floor: SearchHistoryFloor = known.some((value) => value.at === null) ? { known: true, at: null }
    : known.length !== rows.length ? { known: false }
      : { known: true, at: known.reduce((a, b) => timestamp(a.at!) <= timestamp(b.at!) ? a : b).at }
  return { actorId, chatId, floor }
}

/** Backend message_visible_at plus deletion/hide and exact-actor history provenance. */
export function visibleTo(
  document: SearchDocument,
  actorId: string,
  scope: SearchActorScope | null,
  access: SearchDocumentAccess | null,
): boolean {
  if (!scope || scope.actorId !== actorId || scope.chatId !== document.chatId || document.deletedAt !== null) return false
  if (!access || access.actorId !== actorId || access.messageId !== document.id || access.hiddenForActor !== false) return false
  if (scope.floor.known) {
    if (scope.floor.at !== null && timestamp(document.createdAt) < timestamp(scope.floor.at)) return false
  } else if (!access.fromHistory) return false
  return !document.isWhisper || document.senderId === actorId || document.toUserIds.includes(actorId)
}
