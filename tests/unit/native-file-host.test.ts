import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeFileHost } from '../../apps/desktop/electron/nativeFileHost'
import { FILE_CHUNK_BYTES, type FileBytes, type FileRevision } from '@gugu/core/shared/fileResolver'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const bytes = new Uint8Array([0, 255, 7])
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const commitment = { size_bytes: bytes.length, sha256: sha(bytes), content_type: 'application/octet-stream' }
const revision: FileRevision = { ...commitment, source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', relative_path: 'file.bin', host_account_id: 'owner', host_device_id: 'device', host_project_id: 'project' }
const context = { ref: { item_id: 'item' }, actor: { accountId: 'owner', actorId: 'owner' } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-native-file-153-')); roots.push(root)
  let owner: string | null = 'owner'
  const file: FileBytes = { size: bytes.length, read: vi.fn(async (offset, length) => bytes.slice(offset, offset + length)), dispose: vi.fn(async () => {}) }
  const local = vi.fn(async () => ({ revision, open: async () => file }))
  const ssh = vi.fn(async () => file)
  const openPath = vi.fn(async (_path: string) => '')
  const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, _message?: unknown): Promise<unknown> => ({ id: 'item', version: 1 }))
  const publication = vi.fn(async () => true)
  const host = createNativeFileHost({ publish, publication, root, owner: async () => owner, alive: () => true, local, ssh, openPath, published: () => {} })
  const begin = () => host.stage(1, { op: 'begin', name: '../file.bin', revision: commitment }) as Promise<{ id: string }>
  return { root, host, publish, publication, local, ssh, file, openPath, begin, account: (value: string | null) => { owner = value } }
}

describe('native file capabilities are scoped and never expose incomplete originals', () => {
  it('publishes as the authenticated owner and refuses a lost account or closed window', async () => {
    const f = await fixture(), request = { chatId: 'group', file: { name: 'file.bin', path: join(f.root, 'file.bin'), size: 3, contentType: 'application/octet-stream' } }
    await expect(f.host.publish(1, request)).resolves.toEqual({ id: 'item', version: 1 })
    expect(f.publish).toHaveBeenCalledWith('group', request.file, 'owner', undefined, undefined)
    f.account(null)
    await expect(f.host.publish(1, request)).rejects.toThrow('unavailable')
    expect(f.publish).toHaveBeenCalledOnce()
    f.account('owner')
    let finish!: (value: unknown) => void, entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    f.publish.mockImplementationOnce(() => { entered(); return new Promise(done => { finish = done }) })
    const pending = f.host.publish(1, request); await started; await f.host.drop(1); finish({ id: 'item', version: 1 })
    await expect(pending).rejects.toThrow('account or window changed')
  })
  it('plans a local publication without publishing a file or reading any bytes', async () => {
    const f = await fixture()
    await expect(f.host.publish(1, { chatId: 'group' })).resolves.toBe(true)
    expect(f.publication).toHaveBeenCalledWith('group', 'owner')
    expect(f.publish).not.toHaveBeenCalled(); expect(f.file.read).not.toHaveBeenCalled()
  })
  it('keeps handles across a same-account token refresh and revokes them across an account ABA switch', async () => {
    const f = await fixture()
    await f.host.ownerChanged('owner')
    const { id } = await f.begin()
    await f.host.ownerChanged('owner')
    await f.host.stage(1, { op: 'chunk', id, bytes })
    await f.host.ownerChanged('other-owner')
    await f.host.ownerChanged('owner')
    await expect(f.host.stage(1, { op: 'commit', id })).rejects.toThrow('unavailable')
    expect(await readdir(f.root)).toEqual([])
  })
  it('requires exact size and SHA before an OS open; canonical cache repairs same-length tampering', async () => {
    const f = await fixture(), { id } = await f.begin()
    await expect(f.host.open(1, id)).rejects.toThrow('not committed')
    expect(f.openPath).not.toHaveBeenCalled()
    await f.host.stage(1, { op: 'chunk', id, bytes })
    await f.host.stage(1, { op: 'commit', id })
    await f.host.open(1, id)
    const path = f.openPath.mock.calls[0]![0]
    expect(path).toBe(join(f.root, `open-${commitment.sha256}`, 'file.bin'))
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    // A cache file is not trusted just because its size or name still matches.
    await import('node:fs/promises').then(fs => fs.chmod(path, 0o600))
    await writeFile(path, new Uint8Array([9, 9, 9]))
    const again = await f.begin()
    await f.host.stage(1, { op: 'chunk', id: again.id, bytes })
    await f.host.stage(1, { op: 'commit', id: again.id })
    await f.host.open(1, again.id)
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    await expect(f.host.open(1, again.id)).rejects.toThrow('unavailable')
  })

  it.each(['truncated', 'wrong SHA', 'extra bytes', 'oversized frame', 'invalid bytes'])('refuses %s and cleans its private stage without an OS open', async failure => {
    const f = await fixture(), { id } = await f.begin()
    if (failure === 'truncated') await f.host.stage(1, { op: 'chunk', id, bytes: bytes.slice(0, 1) })
    if (failure === 'wrong SHA') await f.host.stage(1, { op: 'chunk', id, bytes: new Uint8Array([1, 2, 3]) })
    if (failure === 'truncated' || failure === 'wrong SHA') await expect(f.host.stage(1, { op: 'commit', id })).rejects.toThrow('SHA-256 mismatch')
    else if (failure === 'invalid bytes') await expect(f.host.stage(1, { op: 'chunk', id, bytes: '文字' as unknown as Uint8Array })).rejects.toThrow('Invalid file bytes')
    else await expect(f.host.stage(1, { op: 'chunk', id, bytes: new Uint8Array(failure === 'extra bytes' ? 4 : FILE_CHUNK_BYTES + 1) })).rejects.toThrow('Invalid file range')
    expect(await readdir(f.root)).toEqual([])
    expect(f.openPath).not.toHaveBeenCalled()
    await expect(f.host.stage(1, { op: 'commit', id })).rejects.toThrow('unavailable')
  })

  it('refuses another renderer, account or actor without consuming the rightful file capability', async () => {
    const f = await fixture()
    const opened = await f.host.read(1, context, { op: 'open', revision }) as { id: string }
    await expect(f.host.read(2, context, { op: 'read', id: opened.id, offset: 0, length: 1 })).rejects.toThrow('unavailable')
    await expect(f.host.read(1, { ...context, actor: { accountId: 'owner', actorId: 'other-agent' } }, { op: 'read', id: opened.id, offset: 0, length: 1 })).rejects.toThrow('another reader')
    f.account('other-owner')
    await expect(f.host.read(1, { ...context, actor: { accountId: 'other-owner', actorId: 'other-owner' } }, { op: 'read', id: opened.id, offset: 0, length: 1 })).rejects.toThrow('account or window changed')
    f.account('owner')
    expect(await f.host.read(1, context, { op: 'read', id: opened.id, offset: 0, length: 3 })).toEqual(bytes)
    await expect(f.host.read(1, context, { op: 'read', id: opened.id, offset: -1, length: 1 })).rejects.toThrow('Invalid file range')
    await f.host.read(1, context, { op: 'dispose', id: opened.id })
    expect(f.file.dispose).toHaveBeenCalledOnce()
  })

  it('a metadata probe never reads bytes, and closing a window during a probe cannot resurrect a handle', async () => {
    const f = await fixture()
    expect(await f.host.read(1, context, { op: 'local' })).toEqual(revision)
    expect(f.file.read).not.toHaveBeenCalled()
    let resolve!: (value: { revision: FileRevision; open(): Promise<FileBytes> }) => void, entered!: () => void
    const probing = new Promise<void>(done => { entered = done })
    f.local.mockImplementationOnce(() => { entered(); return new Promise(done => { resolve = done }) })
    const waiting = f.host.read(1, context, { op: 'open', revision })
    // Synchronize on the actual dependency call, not a wall-clock delay.
    await probing
    expect(f.local).toHaveBeenCalledTimes(2)
    await f.host.drop(1)
    resolve({ revision, open: async () => f.file })
    await expect(waiting).rejects.toThrow('account or window changed')
    expect(f.file.read).not.toHaveBeenCalled()
  })

  it('dropping a scope aborts only its pending stages and disposes only its snapshots', async () => {
    const f = await fixture(), own = await f.begin()
    const other = await f.host.stage(2, { op: 'begin', name: 'other.bin', revision: commitment }) as { id: string }
    await f.host.read(1, context, { op: 'open', revision })
    await f.host.drop(1)
    expect(f.file.dispose).toHaveBeenCalledOnce()
    await expect(f.host.stage(1, { op: 'commit', id: own.id })).rejects.toThrow('unavailable')
    await f.host.stage(2, { op: 'chunk', id: other.id, bytes })
    await f.host.stage(2, { op: 'commit', id: other.id })
    await f.host.open(2, other.id)
    expect(f.openPath).toHaveBeenCalledOnce()
  })
})
