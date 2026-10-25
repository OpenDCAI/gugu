import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectFilePublisher } from '../../../../apps/desktop/electron/projectFilePublication'
import { readProjectFile, rememberProjectGroupId } from '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'

let home: string, root: string, env: NodeJS.ProcessEnv
const data = new Uint8Array([0, 255, 3]), file = { name: 'file.bin', bytes: data.buffer, contentType: 'application/octet-stream' }
const row = { id: 'item', chat_id: 'group', filename: 'file.bin', version: 1, content_type: file.contentType, size_bytes: 3, path: 'file.bin', parent_id: null,
  created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', created_by: 'owner', source_message_ids: [], kind: 'file', pointer: null, epoch: 0, system_role: null }
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-file-publication-153-')); root = join(home, 'project'); env = { GUGU_HOME: home }
  await mkdir(root); await writeFile(join(root, file.name), data)
  await rememberProjectGroupId('project', 'group', 'owner', env)
})
afterEach(async () => { expect(home.startsWith(join(tmpdir(), 'gugu-file-publication-153-'))).toBe(true); await rm(home, { recursive: true, force: true }) })
function fixture(proactive = false) {
  let accountId = 'owner'
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'file_project_policy_for') return { host_device_id: 'device', host_project_id: 'project', proactive_upload: proactive }
    if (name === 'file_device_publish') return { item_id: 'item' }
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
