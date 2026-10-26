import { z } from 'zod'
import { turnFailureReason } from '@gugu/core/shared/ui/systemNotice'
import { assemble, entityKey, membershipId, missingDependencies, type Cell, type EntityValue, type ProjectionCache } from './chatProjectionAlgebra'
import { membershipValue, mergeUnreadRows } from './chatProjection'
import { displayIdentityFromRow } from './displayIdentity'
import { ACCOUNT_REVISION_CURSOR_KEY } from './accountRevisionRuntime'
import { imSelectors, writeChatRows, type AccountImRepository } from './imRepository'
import { chatDb } from './supabase'
import { currentAuthSessionSignal } from './authSessionLoss'
import { composerCardLine } from './composerCardCopy'
import { rendererLogger } from './log'

const log = rendererLogger('im/snapshot')
const row = z.record(z.string(), z.unknown())
const schema = z.object({
  account_id: z.string().min(1), revision: z.string().regex(/^(0|[1-9]\d*)$/),
  chats: z.array(row), memberships: z.array(row), identities: z.array(row),
  previews: z.array(row), unread: z.array(row), overrides: z.array(row),
  presence: z.record(z.string(), z.object({ presence: row })),
})

/** Decode into the existing projection algebra; there is no second list assembler. */
export function decodeAccountSnapshot(value: unknown, accountId: string) {
  const snapshot = schema.parse(value)
  if (snapshot.account_id !== accountId) throw new Error('account snapshot crossed account boundary')
  const cells = new Map<string, Cell>()
  const put = (family: Parameters<typeof entityKey>[0], id: unknown, value: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error(`account snapshot ${family} requires id`)
    const key = entityKey(family, id)
    if (cells.has(key)) throw new Error(`account snapshot duplicated ${key}`)
    cells.set(key, { stamp: snapshot.revision, value: value as EntityValue | null })
  }
  for (const chat of snapshot.chats) put('chat', chat.id, { ...chat, last_message_at: null, last_message_preview: null })
  for (const member of snapshot.memberships) {
    if (typeof member.chat_id !== 'string' || typeof member.user_id !== 'string') throw new Error('invalid snapshot membership')
    put('membership', membershipId(member.chat_id, member.user_id), membershipValue(member))
  }
  for (const identity of snapshot.identities) put('identity', identity.id, displayIdentityFromRow(identity))
  for (const preview of snapshot.previews) put('preview', preview.chat_id, {
    chat_id: preview.chat_id, created_at: preview.created_at,
    preview: typeof preview.preview === 'string' ? composerCardLine(preview.preview) : null,
    failure: turnFailureReason(preview as Parameters<typeof turnFailureReason>[0]),
  })
  const unread = mergeUnreadRows(snapshot.unread as Array<Record<string, unknown> & { chat_id: string }>)
  for (const chat of snapshot.chats) put('unread', chat.id, unread.get(String(chat.id)) ?? null)
  const overrides = new Map(snapshot.overrides.map((value) => [value.target_kind === 'group' ? `group/${value.target_id}` : value.contact_user_id, value]))
  for (const identity of snapshot.identities) put('override', identity.id, overrides.get(identity.id) ?? null)
  for (const chat of snapshot.chats) {
    if (chat.kind === 'group') put('override', `group/${chat.id}`, overrides.get(`group/${chat.id}`) ?? null)
  }
  if (missingDependencies(cells, accountId).length > 0) throw new Error('account snapshot has incomplete identity or conversation closure')
  return { revision: snapshot.revision, cells: cells as ProjectionCache, presence: snapshot.presence }
}

export async function initializeAccountSync(repository: AccountImRepository): Promise<void> {
  const cursor = imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot()) as { revision?: unknown } | undefined
  if (typeof cursor?.revision === 'string' && /^(0|[1-9]\d*)$/.test(cursor.revision)) return
  const startedAt = performance.now()
  const { data, error } = await chatDb.rpc('sync_snapshot').abortSignal(currentAuthSessionSignal())
  if (error) throw error
  const snapshot = decodeAccountSnapshot(data, repository.accountId)
  const chats = assemble(snapshot.cells, repository.accountId)
  const outbox = repository.snapshot().outbox
  await repository.transaction((transaction) => {
    transaction.clear()
    for (const pending of outbox) transaction.putOutbox(pending.value)
    writeChatRows(repository, transaction, chats)
    for (const [key, cell] of snapshot.cells) {
      if (key.startsWith('identity:') && cell.value) transaction.putIdentity(cell.value)
      if (key.startsWith('membership:') && cell.value) {
        const member = cell.value as unknown as { chat_id: string; user_id: string } & Record<string, unknown>
        transaction.putMembership(member.chat_id, member.user_id, member)
      }
    }
    for (const [id, payload] of Object.entries(snapshot.presence)) transaction.putPresence(id, payload.presence)
    transaction.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: snapshot.revision })
  })
  log.info({ revision: snapshot.revision, bytes: new TextEncoder().encode(JSON.stringify(data)).byteLength,
    ms: Math.round(performance.now() - startedAt), chats: chats.length }, 'account snapshot committed')
}
