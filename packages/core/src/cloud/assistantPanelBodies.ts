import { withBoundedOperation } from './boundedOperation'
import { createGuguSupabaseClient } from './supabase'
import { configuredEndpoint, placeAttachment, uploadAttachmentBytes } from './attachmentsApi'
import { cloudFileProviders } from './fileProviders'
import { createCachedFileSink, type FileChunkCache } from '../shared/fileCache'
import { createFileResolver } from '../shared/fileResolver'
import { AssistantPanelError, type AssistantPanelItem } from './assistantPanel'

export type AssistantPanelBodyAccess = {
  token: string; ownerId: string; chatId: string; accountId(): string | null | Promise<string | null>
}
async function assertOwner(input: AssistantPanelBodyAccess): Promise<void> {
  if (await input.accountId() !== input.ownerId) throw new AssistantPanelError('account-changed','Assistant panel account changed')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('')
}

/** Every network stage has a deadline, including direct object bytes. */
function panelEndpoint(token: string) {
  return { ...configuredEndpoint(token),fetch: ((url,init) => withBoundedOperation(30_000,() => new AssistantPanelError('body-timeout','PANEL_BODY_TIMEOUT'),signal => fetch(url,{ ...init,
    signal: AbortSignal.any([signal,...(init?.signal ? [init.signal] : [])]),
  }))) as typeof fetch }
}

/** The existing private file upload/place path; it sends no chat message. */
export async function uploadAssistantPanelBody(input: AssistantPanelBodyAccess & {
  name: string; bytes: Uint8Array; contentType: string
}): Promise<{ itemId: string; sha256: string }> {
  await assertOwner(input)
  const endpoint = panelEndpoint(input.token)
  const digest = await sha256(input.bytes)
  const staging = await uploadAttachmentBytes(endpoint,{
    bytes: input.bytes,name: input.name,contentType: input.contentType,
  },{ chat_id: input.chatId,as: input.ownerId })
  await assertOwner(input)
  const item = await placeAttachment(endpoint,{
    staging_key: staging,chat_id: input.chatId,file_name: input.name,content_type: input.contentType,
    as_user_id: input.ownerId,folder: '.assistant-panel',
  })
  await assertOwner(input)
  if (typeof item.id !== 'string' || item.kind !== 'file') throw new AssistantPanelError('invalid-body','Assistant panel file upload did not return a stored file')
  return { itemId: item.id,sha256: digest }
}

/** Fetch through existing authorized attachment URLs and verify the referenced bytes. */
export async function readAssistantPanelBody(item: AssistantPanelItem, input: AssistantPanelBodyAccess): Promise<Uint8Array> {
  await assertOwner(input)
  if (item.owner_user_id !== input.ownerId) throw new AssistantPanelError('account-changed','Assistant panel account changed')
  if (item.deleted_at) throw new AssistantPanelError('deleted','This resource has been deleted')
  if (!item.body_item_id || !item.body_sha256) throw new AssistantPanelError('body-unavailable','Assistant panel resource content is unavailable')
  const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${input.token}` } })
  const { data,error } = await client.rpc('workspace_get_as',{ p_item_id: item.body_item_id,p_as_user_id: input.ownerId }).abortSignal(AbortSignal.timeout(2000))
  await assertOwner(input)
  const file = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined
  if (error || !file || file.chat_id !== input.chatId || file.kind !== 'file' || typeof file.version !== 'number') {
    throw new AssistantPanelError(error?.code ?? 'body-unavailable','Assistant panel resource content could not be read')
  }
  const chunks = new Map<string, Uint8Array>()
  const cache: FileChunkCache = {
    async get(key,index) { return chunks.get(`${key}:${index}`) ?? null },
    async put(key,index,bytes) { chunks.set(`${key}:${index}`,bytes.slice()) },
    async clear(key) { for (const entry of chunks.keys()) if (entry.startsWith(`${key}:`)) chunks.delete(entry) },
  }
  const provider = cloudFileProviders({ endpoint: async () => { await assertOwner(input); return panelEndpoint(input.token) },
    cache,sink: async size => createCachedFileSink(cache,size),
  })
  const resolve = createFileResolver({ ...provider,local: async () => null,ssh: async () => null,
    temporary: async () => { throw new AssistantPanelError('invalid-body','Panel bodies must be stored in the cloud') },
  })
  const handle = await resolve({ item_id: item.body_item_id,version: file.version },{ accountId: input.ownerId,actorId: input.ownerId })
  if (handle.status !== 'ready') throw new AssistantPanelError('body-unavailable','Assistant panel resource content is unavailable')
  try {
    if (handle.revision.source !== 'managed-object' || handle.revision.sha256 !== item.body_sha256) throw new AssistantPanelError('body-changed','Assistant panel resource content did not match its saved version')
    const bytes = new Uint8Array(handle.revision.size_bytes)
    let offset = 0
    for await (const part of handle.stream()) { await assertOwner(input); bytes.set(part,offset); offset += part.length }
    if (await sha256(bytes) !== item.body_sha256) throw new AssistantPanelError('body-changed','Assistant panel resource content did not match its saved version')
    await assertOwner(input)
    return bytes
  } finally { await handle.dispose(); chunks.clear() }
}

export async function readAssistantPanelText(item: AssistantPanelItem, input: AssistantPanelBodyAccess): Promise<string> {
  return new TextDecoder('utf-8',{ fatal: true }).decode(await readAssistantPanelBody(item,input))
}
