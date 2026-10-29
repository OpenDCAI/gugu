// Shared agent-facing result boundary for synchronous tools and durable human-tool replies.
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs'

/** 出参里的 id 字段 → 带类型。按字段名认，只认这几个宿主自己定义的键。 */
const ID_FIELD_KINDS = {
  session_id: 'session',
  spawned_by_session_id: 'session',
  parent_session_id: 'session',
  related_session_id: 'session',
  recipient_session_id: 'session',
  sender_session_id: 'session',
  project_id: 'project',
  source_project_id: 'project',
  linked_project_id: 'project',
  message_id: 'msg',
  device_id: 'device',
  spawned_by_device_id: 'device',
} as const

type PictureBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const isPicture = (value: unknown): value is { label: string; mimeType: string; data: string } =>
  typeof value === 'object' && value !== null &&
  typeof (value as { label?: unknown }).label === 'string' &&
  typeof (value as { mimeType?: unknown }).mimeType === 'string' &&
  typeof (value as { data?: unknown }).data === 'string'

/**
 * A result's `pictures` (app_check, and app_install's check — `{ label, mimeType, data }`, extension-look-picture.ts) go
 * to the agent as image blocks after the JSON, each said by its label: never as base64 text inside the JSON (~40 KB
 * each, in the agent's context), and never into the audit.
 */
export function withPictures(result: unknown): { shown: unknown; pictures: PictureBlock[] } {
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('pictures' in result)) return { shown: result, pictures: [] }
  const { pictures, ...shown } = result as { pictures?: unknown }
  if (!Array.isArray(pictures) || !pictures.every(isPicture)) throw new Error('host returned pictures that are not { label, mimeType, data }')
  return {
    shown,
    pictures: pictures.flatMap((picture): PictureBlock[] => [
      { type: 'text', text: `Picture: ${picture.label}` },
      { type: 'image', data: picture.data, mimeType: picture.mimeType },
    ]),
  }
}

export function encodeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeResult)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const kind = (ID_FIELD_KINDS as Record<string, (typeof ID_FIELD_KINDS)[keyof typeof ID_FIELD_KINDS]>)[key]
    if (kind && typeof entry === 'string' && entry.length > 0) out[key] = encodeTypedId(kind, entry)
    else if (kind) out[key] = entry
    else out[key] = encodeResult(entry)
  }
  return out
}
