import { z } from 'zod'
const displayIdentitySchema = z.object({
  id: z.string().trim().min(1), type: z.enum(['human', 'agent']),
  display_name: z.string().trim().min(1), avatar: z.string().nullable(), gugu_number: z.number().nullable(),
  name_serial: z.number().int().positive().nullable().optional(),
  bio: z.string().nullable(), owner_user_id: z.string().nullable(), agent_public: z.boolean().nullable(),
  desired_status: z.enum(['online', 'offline']).nullable(),
  session_archived_at: z.string().nullable().optional(), session_lifecycle_revision: z.number().int().nonnegative().optional(),
  device_id: z.string().nullable(), category: z.string().nullable(), is_official: z.boolean().nullable(), local_path: z.string().nullable(), created_at: z.string().nullable(), updated_at: z.string().nullable(),
})
export type DisplayIdentity = z.infer<typeof displayIdentitySchema>
export const displayIdentityFromRow = (value: unknown): DisplayIdentity => displayIdentitySchema.parse(value)

/** Aliases win; only names shared by members of this chat need a serial suffix. */
export function identityDisplayName(
  identity: Pick<DisplayIdentity, 'id' | 'display_name' | 'name_serial'>,
  members: readonly Pick<DisplayIdentity, 'id' | 'display_name'>[] = [],
  alias?: string | null,
): string {
  if (alias?.trim()) return alias.trim()
  const collides = members.some((member) => member.id !== identity.id && member.display_name === identity.display_name)
  return collides && identity.name_serial != null ? `${identity.display_name} · ${identity.name_serial}` : identity.display_name
}
