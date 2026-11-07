import { notify } from '@/lib/notices'
import './connection-copy'

let sequence = 0
const reported = new WeakMap<object,{ sequence: number; key: string }>()
const object = (value: unknown): value is object => value !== null && typeof value === 'object'
export const connectionActionNoticeScope = () => ++sequence

export function isQuietConnectionActionFailure(value: unknown) {
  const failure = value as { code?: string; name?: string; cancelled?: boolean } | null
  return failure?.cancelled === true || failure?.name === 'AbortError'
    || ['quiescing','intent-changed','account-changed','outcome-unknown','operation-pending'].includes(failure?.code ?? '')
}

/** The action and its orchestration share one notice, without changing wire DTOs. */
export function reportConnectionActionFailure(value: unknown,input: { ownerId?: string; provider: string; title: string; after: number },forwarded?: unknown) {
  if (isQuietConnectionActionFailure(value)) return
  const key = `connections-action:${input.ownerId}:${input.provider}`
  const previous = object(value) ? reported.get(value) : undefined
  if (previous && previous.key === key && previous.sequence > input.after) {
    if (object(forwarded)) reported.set(forwarded,previous)
    return
  }
  notify({ key,tier: 'error',title: input.title })
  const notice = { key,sequence: ++sequence }
  if (object(value)) reported.set(value,notice)
  if (object(forwarded)) reported.set(forwarded,notice)
}
