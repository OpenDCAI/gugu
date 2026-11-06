import { AssistantPanelError, type AssistantPanelCommit } from '@gugu/core/cloud/assistantPanel'
import type { ConnectionMetadataItem, ConnectionMetadataSnapshot, ConnectionMetadataStore } from './connection-metadata'

export type ConnectionMetadataCache = {
  peek(): ConnectionMetadataSnapshot | undefined
  save(snapshot: ConnectionMetadataSnapshot): void
}

/** One account's public metadata. Its transport supplies owner RPCs; neither
 * reads nor durable mutations resolve an assistant, home or private folder. */
export function createConnectionMetadataStore(input: {
  ownerId: string
  accountId(): string | null
  assertCurrent(): void | Promise<void>
  read(): Promise<ConnectionMetadataSnapshot>
  commit(change: AssistantPanelCommit): ReturnType<ConnectionMetadataStore['save']>
  cache: ConnectionMetadataCache
  readBody?(item: ConnectionMetadataItem): Promise<Uint8Array>
  changed(): void
}): ConnectionMetadataStore {
  let reading: Promise<ConnectionMetadataSnapshot> | undefined
  const peekSnapshot = () => input.accountId() === input.ownerId ? input.cache.peek() : undefined
  async function snapshot() {
    await input.assertCurrent()
    reading ??= input.read().then(async value => {
      await input.assertCurrent()
      if (value.items.some(row => row.owner_user_id !== input.ownerId)) throw new AssistantPanelError('account-changed', 'CONNECTION_ACCOUNT_CHANGED')
      const previous = peekSnapshot()
      if (previous && BigInt(previous.revision) > BigInt(value.revision)) return previous
      input.cache.save(value)
      return value
    }).finally(() => { reading = undefined })
    return reading
  }
  const live = (item: ConnectionMetadataItem) => peekSnapshot()?.items.find(row => row.resource_key === item.resource_key
    && row.device_id === item.device_id && row.revision === item.revision && !row.deleted_at)
  function publicBody(item: ConnectionMetadataItem) {
    const current = live(item)
    return current?.data.publicMetadata && typeof current.data.publicMetadata === 'object'
      ? new TextEncoder().encode(JSON.stringify(current.data.publicMetadata)) : undefined
  }
  async function mutate(item: ConnectionMetadataItem, operation: AssistantPanelCommit['operation'], data: Record<string, unknown>) {
    await input.assertCurrent()
    if (item.owner_user_id !== input.ownerId || item.domain !== 'integrations' || item.resource_key.startsWith('catalog:'))
      throw new AssistantPanelError('42501', 'CONNECTION_RESOURCE_NOT_OWNED')
    const change = { operationId: crypto.randomUUID(), domain: 'integrations' as const, key: item.resource_key,
      expectedRevision: item.revision, operation, data, deviceId: item.device_id }
    try {
      const receipt = await input.commit(change)
      await input.assertCurrent()
      if (operation === 'remove' && (receipt.status === 'pending' || receipt.status === 'applied')) {
        const previous = peekSnapshot()
        // Keep the tombstone and its revision while the executor is offline.
        // A slower read cannot make the saved account visible again.
        if (previous && BigInt(previous.revision) <= BigInt(receipt.revision)) input.cache.save({ ...previous, revision: receipt.revision,
          items: previous.items.map(row => row.resource_key === item.resource_key && row.device_id === item.device_id
            ? { ...row, revision: receipt.revision, deleted_at: new Date().toISOString(),body_sha256: null,
              data: { providerId: row.data.providerId,accountId: row.data.accountId,configured: false } } : row) })
      }
      return receipt
    } finally { input.changed() }
  }
  return {
    ownerId: input.ownerId, assertCurrent: input.assertCurrent, snapshot, peekSnapshot,
    invalidate: input.changed,
    async collection() { return (await snapshot()).items.filter(row => row.domain === 'integrations' && !row.deleted_at && !row.resource_key.startsWith('__collection__')) },
    peekBody: publicBody,
    async body(item) {
      await input.assertCurrent()
      if (item.owner_user_id !== input.ownerId || item.deleted_at || !live(item)) throw new AssistantPanelError('deleted', 'CONNECTION_RESOURCE_REMOVED')
      const bytes = publicBody(item)
      if (bytes) return bytes
      if (!input.readBody) throw new AssistantPanelError('body-unavailable', 'CONNECTION_PUBLIC_METADATA_UNAVAILABLE')
      const downloaded = await input.readBody(item)
      await input.assertCurrent()
      if (!live(item)) throw new AssistantPanelError('deleted', 'CONNECTION_RESOURCE_REMOVED')
      return downloaded
    },
    change: (item, operation) => mutate(item, operation, {}),
    save: (item, data) => mutate(item, 'save', data),
  }
}
