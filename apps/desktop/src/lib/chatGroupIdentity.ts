import { readDisplayIdentities } from './identityReadAdapter'
import type { DisplayIdentity } from './displayIdentity'

export async function readGroupMemberIdentities(members: readonly { user_id: string }[]): Promise<Map<string, DisplayIdentity>> {
  const memberIdentities = await readDisplayIdentities([...new Set(members.map((member) => member.user_id))])
  const memberIdentityIds = new Set(memberIdentities.map((identity) => identity.id))
  const ownerIds = [...new Set(memberIdentities.flatMap((identity) => identity.type === 'agent' && identity.owner_user_id ? [identity.owner_user_id] : []))]
    .filter((ownerId) => !memberIdentityIds.has(ownerId))
  // Owner attribution belongs to the roster snapshot, so message bubbles never query identities.
  const ownerIdentities = ownerIds.length > 0 ? await readDisplayIdentities(ownerIds) : []
  const resolvedOwnerIds = new Set(ownerIdentities.map((identity) => identity.id))
  const missingOwnerIds = ownerIds.filter((ownerId) => !resolvedOwnerIds.has(ownerId))
  if (missingOwnerIds.length > 0) throw new Error(`Agent owner identities were not returned: ${missingOwnerIds.join(', ')}`)
  return new Map([...memberIdentities, ...ownerIdentities].map((identity) => [identity.id, identity]))
}
