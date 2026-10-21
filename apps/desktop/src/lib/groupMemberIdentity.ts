import { parseAgentPresencePayload } from '@gugu/core/cloud/agentPresenceProtocol'
type PresenceResult = {
  data: unknown
  error: unknown
}

type PresenceLoader = (userId: string) => PromiseLike<PresenceResult>

export async function findTombstonedGroupMemberIds(
  unresolvedMemberIds: string[],
  loadPresence: PresenceLoader,
): Promise<Set<string>> {
  const resolvedIds = await Promise.all(
    unresolvedMemberIds.map(async (userId) => {
      const { data, error } = await loadPresence(userId)
      if (error) return null
      const presence = parseAgentPresencePayload(data)
      return presence?.accountStatus === 'removed' ? userId : null
    }),
  )

  return new Set(resolvedIds.filter((userId): userId is string => userId !== null))
}
