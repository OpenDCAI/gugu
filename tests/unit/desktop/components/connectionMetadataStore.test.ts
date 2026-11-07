import { describe, expect, it, vi } from 'vitest'
import { createConnectionMetadataStore } from '@/components/connections/connection-metadata-store'
import type { ConnectionMetadataSnapshot } from '@/components/connections/connection-metadata'

const row = { owner_user_id: 'owner', domain: 'integrations' as const, resource_key: '["github","a"]', device_id: 'device',
  revision: '4', data: { providerId: 'github', accountId: 'a', configured: true, publicMetadata: { login: 'person' } },
  body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-06T00:00:00Z' }
const snapshot = (): ConnectionMetadataSnapshot => ({ version: 1, revision: '4', items: [{ ...row }], application: [] })
function setup() {
  let owner = 'owner', cached: ConnectionMetadataSnapshot | undefined
  const read = vi.fn(async () => snapshot())
  const commit = vi.fn(async () => ({ operationId: 'operation', revision: '5', status: 'pending' as const }))
  const store = createConnectionMetadataStore({ ownerId: 'owner', accountId: () => owner, read, commit,
    assertCurrent() { if (owner !== 'owner') throw new Error('ACCOUNT_CHANGED') },
    cache: { peek: () => owner === 'owner' ? cached : undefined, save(value) { cached = value } }, changed: vi.fn() })
  return { store, read, commit, switchAccount() { owner = 'other' }, cache(value: ConnectionMetadataSnapshot) { cached = value } }
}

describe('owner connection metadata', () => {
  it('reads saved metadata without an assistant, home or file folder', async () => {
    const { store } = setup()
    expect(await store.collection('integrations')).toEqual([row])
    expect(JSON.parse(new TextDecoder().decode(await store.body(row)))).toEqual({ login: 'person' })
    expect('assistantId' in store).toBe(false)
  })

  it('keeps a committed disconnect hidden when an older request arrives', async () => {
    const { store, commit } = setup()
    await store.snapshot()
    await store.change(row, 'remove')
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ key: row.resource_key, expectedRevision: '4', deviceId: 'device', operation: 'remove' }))
    expect(await store.collection('integrations')).toEqual([])
    expect(store.peekSnapshot?.()?.items[0]?.deleted_at).toBeTruthy()
    expect(store.peekBody?.(row)).toBeUndefined()
    await expect(store.body(row)).rejects.toMatchObject({ code: 'deleted' })
  })

  it('does not replace a newer revocation with an old snapshot', async () => {
    const { store, cache } = setup()
    cache({ ...snapshot(), revision: '10', items: [{ ...row, revision: '10', deleted_at: '2026-11-07T00:00:00Z' }] })
    expect(await store.collection('integrations')).toEqual([])
    expect(store.peekSnapshot?.()?.revision).toBe('10')
  })

  it('rejects an owner switch while a read is in flight', async () => {
    const { store, read, switchAccount } = setup()
    let settle!: (value: ConnectionMetadataSnapshot) => void
    read.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    const pending = store.snapshot()
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    switchAccount()
    settle(snapshot())
    await expect(pending).rejects.toThrow('ACCOUNT_CHANGED')
    expect(store.peekSnapshot?.()).toBeUndefined()
  })

  it('reports a first read failure and retains a previously read snapshot', async () => {
    const { store, read } = setup()
    read.mockRejectedValueOnce(new Error('OFFLINE'))
    await expect(store.collection('integrations')).rejects.toThrow('OFFLINE')
    expect(store.peekSnapshot?.()).toBeUndefined()
    await store.snapshot()
    read.mockRejectedValueOnce(new Error('OFFLINE'))
    await expect(store.snapshot()).rejects.toThrow('OFFLINE')
    expect(store.peekSnapshot?.()?.items).toEqual([row])
  })

  it('rejects cross-owner rows on reads and mutations', async () => {
    const { store, read, commit } = setup()
    read.mockResolvedValueOnce({ ...snapshot(), items: [{ ...row, owner_user_id: 'other' }] })
    await expect(store.snapshot()).rejects.toMatchObject({ code: 'account-changed' })
    await expect(store.change({ ...row, owner_user_id: 'other' }, 'remove')).rejects.toMatchObject({ code: '42501' })
    expect(commit).not.toHaveBeenCalled()
  })
})
