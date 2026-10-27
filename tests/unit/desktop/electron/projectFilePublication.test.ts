import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectFilePublisher } from '../../../../apps/desktop/electron/projectFilePublication'
import { readProjectFile, rememberProjectGroupId } from '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'
const copyFault = vi.hoisted(() => ({ mode: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    await fs.copyFile(...args)
    if (copyFault.mode === 'changed-source') await fs.writeFile(args[0], new Uint8Array([9, 9, 9]))
    if (copyFault.mode === 'copy-failure') throw new Error('injected copy failure')
  } }
})

let home: string, root: string, env: NodeJS.ProcessEnv
const data = new Uint8Array([0, 255, 3]), file = { name: 'file.bin', bytes: data.buffer, contentType: 'application/octet-stream' }
const row = { id: 'item', chat_id: 'group', filename: 'file.bin', version: 1, content_type: file.contentType, size_bytes: 3, path: 'file.bin', parent_id: null,
  created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', created_by: 'owner', source_message_ids: [], kind: 'file', pointer: null, epoch: 0, system_role: null }
beforeEach(async () => {
  copyFault.mode = ''
  home = await mkdtemp(join(tmpdir(), 'gugu-file-publication-153-')); root = join(home, 'project'); env = { GUGU_HOME: home }
  await mkdir(root); await writeFile(join(root, file.name), data)
  await rememberProjectGroupId('project', 'group', 'owner', env)
})

describe('external selections become durable project-owned copies through the same publisher', () => {
  const selected = () => ({ name: file.name, path: join(home, 'selected.bin'), size: data.length, contentType: file.contentType })
  const publishedPaths = (f: ReturnType<typeof fixture>) => f.rpc.mock.calls.filter(([name]) => name === 'file_device_publish').map(([, args]) => args.p_path as string)
  it('copies into a unique fenced directory, never overwrites a same-name original, and survives original deletion', async () => {
    const f = fixture(); await writeFile(selected().path, data)
    await f.publish('group', selected(), null, 'owner')
    const [path] = publishedPaths(f)
    expect(path).toMatch(/^\.gugu\/attachments\/[0-9a-f-]{36}\/file\.bin$/)
    expect(await readFile(join(root, path))).toEqual(Buffer.from(data))
    await rm(selected().path)
    expect(await readFile(join(root, path))).toEqual(Buffer.from(data))
    expect(await readFile(join(root, file.name))).toEqual(Buffer.from(data))
    expect(f.store).not.toHaveBeenCalled()
  })
  it('reuses a verified indexed copy for repeated identical content even when the incoming name changes', async () => {
    const f = fixture(); await writeFile(selected().path, data)
    await f.publish('group', selected(), null, 'owner')
    await f.publish('group', { ...selected(), name: 'renamed.bin' }, null, 'owner')
    expect(publishedPaths(f)[1]).toBe(publishedPaths(f)[0])
    expect(await readdir(join(root, '.gugu/attachments'))).toHaveLength(1)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'file_device_publish')[1][1].p_filename).toBe('renamed.bin')
  })
  it('imports a pasted file that has no disk path from its bytes, leaving no temp copy behind', async () => {
    const f = fixture(), pasted = { name: 'image.png', path: '', size: data.length, contentType: 'image/png', data: data.buffer }
    await expect(f.publish('group', pasted, null, 'owner')).resolves.toEqual(row)
    const [path] = publishedPaths(f)
    expect(path).toMatch(/^\.gugu\/attachments\/[0-9a-f-]{36}\/image\.png$/)
    expect(await readFile(join(root, path))).toEqual(Buffer.from(data))
    expect(f.rpc.mock.calls.find(([name]) => name === 'file_device_publish')?.[1]).toMatchObject({ p_filename: 'image.png', p_type: 'image/png', p_sha: createHash('sha256').update(data).digest('hex') })
    expect((await readdir(tmpdir())).filter(name => name.startsWith('gugu-pasted-'))).toHaveLength(0)
  })
  it('refuses pasted bytes that disagree with the declared size or arrive with a path', async () => {
    const f = fixture(), pasted = { name: 'image.png', path: '', size: data.length, contentType: 'image/png', data: data.buffer }
    await expect(f.publish('group', { ...pasted, size: data.length + 1 }, null, 'owner')).rejects.toThrow('Pasted file')
    await expect(f.publish('group', { ...pasted, path: join(home, 'selected.bin') }, null, 'owner')).rejects.toThrow('Pasted file')
    expect(publishedPaths(f)).toEqual([])
  })
  it.each(['missing', 'corrupt'])('imports again when its indexed copy is %s, without reusing invalid bytes', async state => {
    const f = fixture(); await writeFile(selected().path, data)
    await f.publish('group', selected(), null, 'owner')
    const old = join(root, publishedPaths(f)[0])
    if (state === 'missing') await rm(old); else await writeFile(old, new Uint8Array([9, 9, 9]))
    await f.publish('group', selected(), null, 'owner')
    expect(publishedPaths(f)[1]).not.toBe(publishedPaths(f)[0])
    expect(await readFile(join(root, publishedPaths(f)[1]))).toEqual(Buffer.from(data))
  })
  it.each(['missing', 'corrupt'])('reuses the repaired copy on the next real new-item publication after a %s copy', async state => {
    const f = fixture(), originalRpc = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation(async (name, args) => name === 'file_device_publish' ? { item_id: args.p_item }
      : name === 'workspace_get_as' ? [{ ...row, id: args.p_item_id }] : originalRpc(name, args))
    await writeFile(selected().path, data)
    await f.publish('group', selected(), null, 'owner')
    const old = join(root, publishedPaths(f)[0])
    if (state === 'missing') await rm(old); else await writeFile(old, new Uint8Array([9, 9, 9]))
    await f.publish('group', selected(), null, 'owner')
    await f.publish('group', selected(), null, 'owner')
    const paths = publishedPaths(f)
    expect(paths[1]).not.toBe(paths[0]); expect(paths[2]).toBe(paths[1])
    expect(await readFile(join(root, paths[2]))).toEqual(Buffer.from(data))
    expect(await readdir(join(root, '.gugu/attachments'))).toHaveLength(2)
    expect(f.store).not.toHaveBeenCalled()
  })
  it.each(['.gugu', '.gugu/attachments'])('rejects a %s symlink escaping the root before copying or publishing', async link => {
    const f = fixture(), outside = join(home, 'outside'); await mkdir(outside); await writeFile(selected().path, data)
    if (link.includes('/')) await mkdir(join(root, '.gugu'))
    await symlink(outside, join(root, link))
    await expect(f.publish('group', selected(), null, 'owner')).rejects.toThrow('outside')
    expect(await readdir(outside)).toEqual([]); expect(publishedPaths(f)).toEqual([])
  })
  it.each(['copy-failure', 'changed-source'])('cleans only its unpublished copy after %s, keeping the user original and no index', async mode => {
    const f = fixture(); await writeFile(selected().path, data); copyFault.mode = mode
    await expect(f.publish('group', selected(), null, 'owner')).rejects.toThrow()
    expect(await readdir(join(root, '.gugu/attachments'))).toEqual([])
    expect(await readFile(join(root, file.name))).toEqual(Buffer.from(data))
    expect(publishedPaths(f)).toEqual([]); expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).toBeNull()
  })
  it('retains its complete local copy when publication fails, without inventing an indexed reference', async () => {
    const f = fixture(); await writeFile(selected().path, data)
    f.rpc.mockResolvedValueOnce({ host_device_id: 'device', host_project_id: 'project', proactive_upload: false }).mockRejectedValueOnce(new Error('publication outcome unknown'))
    await expect(f.publish('group', selected(), null, 'owner')).rejects.toThrow('publication outcome unknown')
    const directories = await readdir(join(root, '.gugu/attachments'))
    expect(directories).toHaveLength(1)
    expect(await readFile(join(root, '.gugu/attachments', directories[0], file.name))).toEqual(Buffer.from(data))
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).toBeNull()
  })
})
afterEach(async () => { expect(home.startsWith(join(tmpdir(), 'gugu-file-publication-153-'))).toBe(true); await rm(home, { recursive: true, force: true }) })
function fixture(proactive = false) {
  let accountId = 'owner'
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'file_project_policy_for') return { host_device_id: 'device', host_project_id: 'project', proactive_upload: proactive }
    if (name === 'file_device_publish') return { item_id: 'item', ...(_args.p_message ? { message: { id: 'message', file_item_id: 'item', file_version: 1 } } : {}) }
    if (name === 'workspace_get_as') return [row]
    throw new Error(`Unexpected RPC ${name}`)
  })
  const store = vi.fn(async () => row)
  const publish = createProjectFilePublisher({ identity: async () => ({ accountId, deviceId: 'device' }), root: async () => root, rpc, env })
  return { publish, rpc, store, account: (value: string) => { accountId = value } }
}
describe('project file publication runs before document conversion or cloud upload', () => {
  it('publishes only metadata by default and stores authentic workspace fields in the existing local index', async () => {
    const f = fixture()
    expect(await f.publish('group', file, null, 'owner', f.store)).toEqual(row)
    expect(f.store).not.toHaveBeenCalled()
    const publication = f.rpc.mock.calls.find(([name]) => name === 'file_device_publish')![1]
    expect(publication).toMatchObject({ p_path: 'file.bin', p_sha: createHash('sha256').update(data).digest('hex'), p_size: 3, p_device: 'device' })
    expect(Object.values(publication)).not.toContain(root)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).toMatchObject({ workspace: { path: row.path, created_at: row.created_at, created_by: row.created_by }, sha256: publication.p_sha })
  })
  it('reuses the one ordinary uploader only when proactive upload was explicitly enabled', async () => {
    const f = fixture(true)
    expect(await f.publish('group', file, null, 'owner', f.store)).toEqual(row)
    expect(f.store).toHaveBeenCalledOnce()
    expect(f.rpc.mock.calls.some(([name]) => name === 'file_device_publish')).toBe(false)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).not.toBeNull()
  })
  it('plans without publishing and commits a message in the same existing publication RPC', async () => {
    const f = fixture(), message = { message_id: 'message', chat_id: 'group', sender_user_id: 'owner', file_name: file.name, to_user_ids: ['member'], caption: 'caption' }
    await expect(f.publish.local('group', 'owner')).resolves.toBe(true)
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['file_project_policy_for'])
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).toBeNull()
    await expect(f.publish('group', { name: file.name, path: join(root, file.name), size: data.length, contentType: file.contentType }, null, 'owner', undefined, message))
      .resolves.toMatchObject({ ...row, message: { id: 'message', file_item_id: 'item', file_version: 1 } })
    expect(f.rpc.mock.calls.find(([name]) => name === 'file_device_publish')?.[1]).toMatchObject({ p_message: message })
    expect(f.store).not.toHaveBeenCalled()
  })
  it('publishes a native selection through the same fence and streamed SHA without transporting its bytes', async () => {
    const f = fixture(), selected = { name: file.name, path: join(root, file.name), size: data.length, contentType: file.contentType }
    expect(await f.publish('group', selected, null, 'owner')).toEqual(row)
    expect(f.rpc.mock.calls.find(([name]) => name === 'file_device_publish')?.[1]).toMatchObject({ p_path: file.name, p_sha: createHash('sha256').update(data).digest('hex'), p_size: data.length })
    for (const path of [join(home, 'secret'), '', 'relative/file.bin']) {
      await expect(f.publish('group', { ...selected, path }, null, 'owner')).rejects.toThrow()
    }
    await expect(f.publish('group', { ...selected, size: 4 }, null, 'owner')).rejects.toThrow('original file')
  })
  it('returns the ordinary provider decision before opening a native selection when cloud upload is enabled', async () => {
    const f = fixture(true)
    expect(await f.publish('group', { name: file.name, path: '', size: data.length, contentType: file.contentType }, null, 'owner')).toBeNull()
    expect(f.store).not.toHaveBeenCalled()
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['file_project_policy_for'])
  })
  it('leaves non-project uploads with their existing uploader', async () => {
    const f = fixture()
    expect(await f.publish('ordinary', file, null, 'owner', f.store)).toBeNull()
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.store).not.toHaveBeenCalled()
  })
  it.each(['different bytes', 'traversal', 'outside symlink', 'other host'])('rejects %s before publishing or uploading bytes', async failure => {
    const f = fixture()
    let selected = file
    if (failure === 'different bytes') await writeFile(join(root, file.name), new Uint8Array([9, 9, 9]))
    if (failure === 'traversal') selected = { ...file, name: '../secret' }
    if (failure === 'outside symlink') {
      await writeFile(join(home, 'secret'), data); await rm(join(root, file.name)); await symlink(join(home, 'secret'), join(root, file.name))
    }
    if (failure === 'other host') f.rpc.mockResolvedValueOnce({ host_device_id: 'remote', host_project_id: 'project' })
    await expect(f.publish('group', selected, null, 'owner', f.store)).rejects.toThrow()
    expect(f.store).not.toHaveBeenCalled()
    expect(f.rpc.mock.calls.some(([name]) => name === 'file_device_publish')).toBe(false)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'device', env)).toBeNull()
  })
  it('does not invent local metadata when the cloud store or final account check fails', async () => {
    const f = fixture(true)
    f.store.mockImplementation(async () => { f.account('other'); return row })
    await expect(f.publish('group', file, null, 'owner', f.store)).rejects.toThrow('account changed')
    const mapping = await readFile(join(home, 'taskpage-project-groups.json'), 'utf8')
    expect(mapping).not.toContain('"sha256"')
  })
})
