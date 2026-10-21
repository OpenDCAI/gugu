import { z } from 'zod'
const displayIdentitySchema = z.object({
  id: z.string().trim().min(1), type: z.enum(['human', 'agent']),
  display_name: z.string().trim().min(1), avatar: z.string().nullable(), gugu_number: z.number().nullable(),
  bio: z.string().nullable(), owner_user_id: z.string().nullable(), agent_public: z.boolean().nullable(),
  desired_status: z.enum(['online', 'offline']).nullable(),
  device_id: z.string().nullable(), category: z.string().nullable(), is_official: z.boolean().nullable(), local_path: z.string().nullable(), created_at: z.string().nullable(), updated_at: z.string().nullable(),
})
export type DisplayIdentity = z.infer<typeof displayIdentitySchema>
export const displayIdentityFromRow = (value: unknown): DisplayIdentity => displayIdentitySchema.parse(value)
