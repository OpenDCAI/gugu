import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { AuditInput } from './contracts'
import { VaultError } from './contracts'

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const uuid = z.uuid()
export const identity = z.string().regex(/^(?:(?:user|session|agent):)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export function httpsOrigin(input: string): string {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
    return url.origin
  } catch { throw new VaultError('INVALID_INPUT') }
}
const origin = z.string().refine(value => { try { return httpsOrigin(value) === value } catch { return false } })
export const auditSchema = z.strictObject({
  id: uuid,
  action: z.enum(['pre-submit', 'setup', 'recovery', 'unlock', 'lock', 'add', 'edit', 'delete', 'request', 'decision', 'use', 'invalidate', 'clear']),
  loginSurfaceId: uuid.optional(), agentId: identity.optional(), sessionId: identity.optional(), requestId: uuid.optional(), useId: uuid.optional(),
  credential: z.strictObject({ id: uuid, version: z.number().int().positive() }).optional(), origin: origin.optional(),
  decision: z.enum(['allow-once', 'reject', 'cancel', 'expire']).optional(),
  source: z.enum(['local-person', 'policy', 'browser', 'lifecycle']),
  outcome: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired', 'invalidated', 'completed', 'failed', 'uncertain', 'submitted_unconfirmed', 'login_confirmed', 'person_interaction_required']),
})
export const recordSchema = auditSchema.extend({ id: uuid, at: z.iso.datetime(), accountId: identity })
export const credentialInputSchema = z.strictObject({ origin: z.string(), account: z.string().min(1).max(4096), password: z.string().min(1).max(65536) })
export const payloadSchema = z.strictObject({
  operations: z.array(z.strictObject({ id: uuid, kind: z.enum(['save', 'delete']), status: z.enum(['pending', 'committed']), digest: z.string().regex(/^[a-f0-9]{64}$/), credentialId: uuid, version: z.number().int().positive(), origin, auditId: uuid })),
  credentials: z.array(z.strictObject({ id: uuid, version: z.number().int().positive(), origin, account: z.string().min(1).max(4096), password: z.string().min(1).max(65536) })),
})
const sealedSchema = z.strictObject({ nonce: z.string(), tag: z.string(), ciphertext: z.string() })
export const documentSchema = z.strictObject({
  schema: z.literal(1), owner: z.string().regex(/^[a-f0-9]{64}$/), installationId: uuid, vaultId: uuid,
  localKey: z.string(), recoveryKey: sealedSchema, payload: sealedSchema,
})
export const installationSchema = z.strictObject({ schema: z.literal(1), id: uuid, binding: z.string().regex(/^[a-f0-9]{64}$/), owners: z.array(z.string().regex(/^[a-f0-9]{64}$/)) })
export type VaultDocument = z.infer<typeof documentSchema>
export type VaultPayload = z.infer<typeof payloadSchema>
export type Installation = z.infer<typeof installationSchema>
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new VaultError('DATA_DAMAGED')
  return result.data
}
export function auditInput(value: AuditInput): AuditInput {
  const result = auditSchema.safeParse(value)
  if (!result.success) throw new VaultError('INVALID_INPUT')
  return result.data
}
export function binding(document: Pick<VaultDocument, 'owner' | 'installationId' | 'vaultId'>, purpose: 'data' | 'recovery' | 'local'): string {
  return JSON.stringify(['gugu-password-vault', 1, document.owner, document.installationId, document.vaultId, purpose])
}
export function maskedAccount(value: string): string {
  // Never project user-entered text into Agent-visible metadata, even a short account.
  return value.length > 0 ? '••••' : ''
}
