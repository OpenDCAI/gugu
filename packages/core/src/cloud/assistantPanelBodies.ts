import { createGuguSupabaseClient } from './supabase'
import { configuredEndpoint, fetchAttachmentUrls, placeAttachment, uploadAttachmentBytes } from './attachmentsApi'
import { createAttachmentResolver } from '../shared/attachmentUrls'
import { AssistantPanelError, type AssistantPanelItem } from './assistantPanel'

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('')
}

/** The existing private file upload/place path; it sends no chat message. */
export async function uploadAssistantPanelBody(input: {
  token: string; ownerId: string; chatId: string; name: string; bytes: Uint8Array; contentType: string
}): Promise<{ itemId: string; sha256: string }> {
  const endpoint = configuredEndpoint(input.token)
  const digest = await sha256(input.bytes)
  const staging = await uploadAttachmentBytes(endpoint,{
    bytes: input.bytes,name: input.name,contentType: input.contentType,
  },{ chat_id: input.chatId,as: input.ownerId })
  const item = await placeAttachment(endpoint,{
    staging_key: staging,chat_id: input.chatId,file_name: input.name,content_type: input.contentType,
    as_user_id: input.ownerId,folder: '.assistant-panel',
  })
  if (typeof item.id !== 'string' || item.kind !== 'file') throw new AssistantPanelError('invalid-body','Assistant panel file upload did not return a stored file')
  return { itemId: item.id,sha256: digest }
}

/** Fetch through existing authorized attachment URLs and verify the referenced bytes. */
export async function readAssistantPanelBody(item: AssistantPanelItem, input: { token: string; ownerId: string; chatId: string }): Promise<Uint8Array> {
  if (item.deleted_at) throw new AssistantPanelError('deleted','This resource has been deleted')
  if (!item.body_item_id || !item.body_sha256) throw new AssistantPanelError('body-unavailable','Assistant panel resource content is unavailable')
  const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${input.token}` } })
  const { data,error } = await client.rpc('workspace_get_as',{ p_item_id: item.body_item_id,p_as_user_id: input.ownerId })
  const file = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined
  if (error || !file || file.chat_id !== input.chatId || file.kind !== 'file' || typeof file.version !== 'number') {
    throw new AssistantPanelError(error?.code ?? 'body-unavailable','Assistant panel resource content could not be read')
  }
  const resolver = createAttachmentResolver(refs => fetchAttachmentUrls(configuredEndpoint(input.token),refs))
  const signed = await resolver.resolve({ kind: 'item',itemId: item.body_item_id,version: file.version })
  if (signed.status !== 'ready') throw new AssistantPanelError('body-unavailable','Assistant panel resource content is unavailable')
  const response = await fetch(signed.url)
  if (!response.ok) throw new AssistantPanelError('body-unavailable','Assistant panel resource download failed')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (await sha256(bytes) !== item.body_sha256) throw new AssistantPanelError('body-changed','Assistant panel resource content did not match its saved version')
  return bytes
}

export async function readAssistantPanelText(item: AssistantPanelItem, input: { token: string; ownerId: string; chatId: string }): Promise<string> {
  return new TextDecoder('utf-8',{ fatal: true }).decode(await readAssistantPanelBody(item,input))
}
