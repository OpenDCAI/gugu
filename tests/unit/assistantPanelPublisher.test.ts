import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AssistantPanelClient, AssistantPanelCommit, AssistantPanelItem, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { collectAssistantPanelFiles, publishAssistantPanelCollection, type PanelObservation } from '../../apps/desktop/electron/sessionpage/assistant-panel-publisher'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'panel-publisher-')); roots.push(root)
  const binding = { ownerId: 'owner',assistantId: 'assistant',home: root,cwd: join(root,'assistant'),kind: 'computer' as const }
  await mkdir(binding.cwd)
  return { root,binding,paths: assistantHomePaths(root,binding.cwd,'computer') }
}
function transport() {
  let revision = 0
  const rows = new Map<string, AssistantPanelItem>()
  const receipts = new Map<string, { operationId: string; revision: string; status: 'applied' }>()
  const calls: AssistantPanelCommit[] = []
  let lose = false
  let removeBeforeCommit = false
  const cloud = {
    resource: vi.fn(async (_assistant,domain,key) => rows.get(`${domain}:${key}`) ?? null),
    snapshot: vi.fn(async (): Promise<AssistantPanelSnapshot> => ({ version: 1 as const,revision: String(revision),items: [...rows.values()].filter(row => !row.deleted_at),application: [] })),
    commit: vi.fn(async (_assistant,change: AssistantPanelCommit) => {
      calls.push(change)
      const prior = receipts.get(change.operationId)
      if (prior) return prior
      const key = `${change.domain}:${change.key}`, old = rows.get(key)
      if (removeBeforeCommit && change.operation === 'save') {
        removeBeforeCommit = false
        rows.set(key,{ ...old!,revision: String(++revision),deleted_at: '2026-10-26',data: {},body_item_id: null,body_sha256: null })
      }
      if ((rows.get(key)?.revision ?? '0') !== change.expectedRevision) throw new AssistantPanelError('40001','changed')
      const receipt = { operationId: change.operationId,revision: String(++revision),status: 'applied' as const }
      rows.set(key,{ assistant_user_id: 'assistant',owner_user_id: 'owner',domain: change.domain,resource_key: change.key,
        revision: receipt.revision,device_id: change.deviceId ?? null,data: change.data ?? {},body_item_id: change.body?.itemId ?? null,
        body_sha256: change.body?.sha256 ?? null,deleted_at: change.operation === 'remove' ? '2026-10-26' : null,observed_at: null,updated_at: '2026-10-26',
      })
      receipts.set(change.operationId,receipt)
      if (lose) { lose = false; throw new Error('response lost') }
      return receipt
    }),
  } satisfies Pick<AssistantPanelClient, 'resource' | 'snapshot' | 'commit'>
  const input = { assistantId: 'assistant',instanceId: 'runtime',deviceId: 'device',domain: 'memory' as const,cloud,
    collect: vi.fn<() => Promise<PanelObservation[]>>(async () => [{ key: 'note',data: { relativePath: 'note.md' },bytes: new TextEncoder().encode('private note') }]),
    upload: vi.fn(async () => ({ itemId: 'body',sha256: createHash('sha256').update('private note').digest('hex') })),
    discard: vi.fn(async () => {}),revoke: vi.fn(async () => {}),
  }
  return { rows,calls,input,loseNextResponse: () => { lose = true },deleteWhileUploading: () => { removeBeforeCommit = true } }
}

it('publishes complete bodies before readiness and reuses the same receipt after a lost response', async () => {
  const f = transport(); f.loseNextResponse()
  await publishAssistantPanelCollection(f.input)
  expect(f.calls[0].operationId).toBe(f.calls[1].operationId)
  expect(f.rows.get('memory:note')?.body_item_id).toBe('body')
  expect(f.rows.get('memory:__collection__')?.data).toEqual({ state: 'ready',schemaVersion: 1,itemCount: 1 })
  await publishAssistantPanelCollection(f.input)
  expect(f.input.upload).toHaveBeenCalledTimes(1)
})

it('revokes a stale local file without uploading when its cloud key was deleted', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.rows.get('memory:note')!.deleted_at = '2026-10-26'
  f.input.upload.mockClear()
  await publishAssistantPanelCollection(f.input)
  expect(f.input.revoke).toHaveBeenCalledOnce()
  expect(f.input.upload).not.toHaveBeenCalled()
  expect(f.rows.get('memory:note')?.deleted_at).toBeTruthy()
})

it('discards the late uploaded body and revokes the local file when deletion wins the version race', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.collect.mockResolvedValue([{ key: 'note',data: { relativePath: 'note.md',title: 'changed' },bytes: new TextEncoder().encode('late body') }])
  f.deleteWhileUploading()
  await publishAssistantPanelCollection(f.input)
  expect(f.input.discard).toHaveBeenCalledWith('body')
  expect(f.input.revoke).toHaveBeenCalledOnce()
  expect(f.rows.get('memory:note')?.body_item_id).toBeNull()
  expect(f.rows.get('memory:__collection__')?.data.itemCount).toBe(0)
})

it('retains prior content and marks the collection unreadable after a real read failure', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.collect.mockRejectedValue(new Error('permission denied'))
  await expect(publishAssistantPanelCollection(f.input)).rejects.toThrow('permission denied')
  expect(f.rows.get('memory:note')?.body_item_id).toBe('body')
  expect(f.rows.get('memory:__collection__')?.data.state).toBe('error')
})

it('collects nested actual files and rejects symlink escape even for an empty directory', async () => {
  const f = await fixture()
  await mkdir(join(f.paths.resourcesDir,'nested'),{ recursive: true })
  await writeFile(join(f.paths.resourcesDir,'nested','source.txt'),'source')
  const rows = await collectAssistantPanelFiles(f.binding,'files')
  expect(rows.map(row => row.data.path)).toEqual(['nested','nested/source.txt'])
  expect(rows[1].bytes).toEqual(new Uint8Array(await readFile(join(f.paths.resourcesDir,'nested','source.txt'))))
  const external = join(f.root,'external'); await mkdir(external)
  await rm(f.paths.resourcesDir,{ recursive: true })
  await symlink(external,f.paths.resourcesDir)
  await expect(collectAssistantPanelFiles(f.binding,'files')).rejects.toThrow('PANEL_PATH_OUTSIDE_HOME')
})


it('never publishes an old local observation over a pending edit or an edit arriving during collection', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  const current = f.rows.get('memory:note')!
  const cloudEdit = { ...current,revision: '100',data: { relativePath: 'note.md',title: 'Owner edit' } }
  f.input.collect.mockImplementation(async () => { f.rows.set('memory:note',cloudEdit); return [{ key: 'note',data: current.data,bytes: new TextEncoder().encode('old local') }] })
  await publishAssistantPanelCollection(f.input)
  expect(f.rows.get('memory:note')?.data.title).toBe('Owner edit')
  f.input.collect.mockResolvedValue([{ key: 'note',data: current.data }])
  const snapshot = f.input.cloud.snapshot
  snapshot.mockImplementation(async () => ({ version: 1,revision: '100',items: [...f.rows.values()],application: [
    { operationId: 'owner-edit',revision: '100',domain: 'memory',resourceKey: 'note',status: 'pending',errorCode: null },
  ] }))
  await publishAssistantPanelCollection(f.input)
  expect(f.rows.get('memory:note')?.data.title).toBe('Owner edit')
  // A pending newly uploaded resource is not deleted just because the host has
  // not applied it to disk yet.
  f.input.collect.mockResolvedValue([])
  await publishAssistantPanelCollection(f.input)
  expect(f.rows.get('memory:note')?.deleted_at).toBeNull()
})
