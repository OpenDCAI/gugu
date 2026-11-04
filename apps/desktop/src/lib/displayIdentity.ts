import { z } from 'zod'
const displayIdentitySchema = z.object({
  id: z.string().trim().min(1), type: z.enum(['human', 'agent']),
  display_name: z.string().trim().min(1), avatar: z.string().nullable(), gugu_number: z.number().nullable(),
  bio: z.string().nullable(), owner_user_id: z.string().nullable(), agent_public: z.boolean().nullable(),
  desired_status: z.enum(['online', 'offline']).nullable(),
  removed_at: z.string().nullable().optional(),
  nameSerial: z.number().int().positive().nullable().default(null),
  session_archived_at: z.string().nullable().optional(), session_lifecycle_revision: z.number().int().nonnegative().optional(),
  device_id: z.string().nullable(), category: z.string().nullable(), is_official: z.boolean().nullable(), local_path: z.string().nullable(), created_at: z.string().nullable(), updated_at: z.string().nullable(),
})
const parsedDisplayIdentitySchema = z.preprocess(value => value && typeof value === 'object' && 'name_serial' in value
  ? { ...value, nameSerial: value.name_serial } : value, displayIdentitySchema)
export type DisplayIdentity = z.infer<typeof parsedDisplayIdentitySchema>
export const displayIdentityFromRow = (value: unknown): DisplayIdentity => parsedDisplayIdentitySchema.parse(value)
