import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localFileRevision } from '../../../../apps/desktop/src/lib/fileAccess'
const f = vi.hoisted(() => ({ invoke: vi.fn(), fetch: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'owner' } }), getRendererAccessToken: () => 'fixture-token', observeRendererSession: () => () => {} }))
const revision = { source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', size_bytes: 0, sha256: 'ab'.repeat(32), content_type: 'application/octet-stream', host_account_id: 'owner', host_device_id: 'device', host_project_id: 'project', relative_path: 'file.bin' }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('window', { electronAPI: { invoke: f.invoke } }); vi.stubGlobal('fetch', f.fetch)
  f.fetch.mockRejectedValue(new Error('No cloud request allowed')); f.invoke.mockResolvedValue(revision)
})
afterEach(() => { vi.unstubAllGlobals() })
describe('local file UI metadata uses the existing resolver without byte or cloud acquisition', () => {
  it('returns authentic local placement with one local metadata IPC, never a byte read', async () => {
    await expect(localFileRevision('item')).resolves.toEqual(revision)
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('files:read', { op: 'local', ref: { item_id: 'item' }, actor: { accountId: 'owner', actorId: 'owner' } })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('a local miss does not fetch remote metadata, sign or acquire bytes', async () => {
    f.invoke.mockResolvedValue(null)
    await expect(localFileRevision('cloud-item')).resolves.toBeNull()
    expect(f.invoke).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('a browser has no local disk provider and does not invoke or fetch', async () => {
    vi.stubGlobal('window', {})
    await expect(localFileRevision('cloud-item')).resolves.toBeNull()
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([{ ...revision, host_account_id: 'other' }, { ...revision, sha256: 'tampered' }])('refuses invalid local authority without falling back to cloud', async value => {
    f.invoke.mockResolvedValue(value)
    await expect(localFileRevision('item')).rejects.toThrow()
    expect(f.invoke).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled()
  })
})
