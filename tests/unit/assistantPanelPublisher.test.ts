import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AssistantPanelClient, AssistantPanelCommit, AssistantPanelItem, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { collectAssistantPanelFiles, publishAssistantPanelCollection, type PanelObservation } from '../../apps/desktop/electron/sessionpage/assistant-panel-publisher'
import { createAssistantPanelBodyFailures } from '../../apps/desktop/electron/sessionpage/assistant-panel-body-failures'

const roots: string[] = []
const cacheLog = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../../apps/desktop/electron/lib/logger',() => ({ createLogger: () => cacheLog }))
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true }))) })
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
  const failures = new Map<string, { sha256: string; code: 'invalid-body' }>()
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
    bodyFailures: {
      get: async (domain: string,key: string) => failures.get(`${domain}:${key}`),
      set: async (domain: string,key: string,failure: { sha256: string; code: 'invalid-body' }) => { failures.set(`${domain}:${key}`,failure) },
      clear: async (domain: string,key: string) => { failures.delete(`${domain}:${key}`) },
      retain: async (domain: string,keys: ReadonlySet<string>) => {
        for (const key of failures.keys()) if (key.startsWith(`${domain}:`) && !keys.has(key.slice(domain.length+1))) failures.delete(key)
      },
    },
    collect: vi.fn<(previous?: AssistantPanelItem[]) => Promise<PanelObservation[]>>(async () => [{ key: 'note',data: { relativePath: 'note.md' },bytes: new TextEncoder().encode('private note') }]),
    upload: vi.fn(async (row: PanelObservation) => ({ itemId: 'body',sha256: createHash('sha256').update(row.bytes!).digest('hex') })),
    discard: vi.fn(async () => {}),revoke: vi.fn(async () => {}),
  }
  return { rows,calls,input,failures,loseNextResponse: () => { lose = true },deleteWhileUploading: () => { removeBeforeCommit = true } }
}

it('uploads zero bodies across repeated metadata-only inventory sweeps', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.upload.mockClear()
  for (let checkedAt = 1; checkedAt <= 20; checkedAt++) {
    f.input.collect.mockResolvedValue([{ key: 'note',data: { relativePath: 'note.md',checkedAt },bytes: new TextEncoder().encode('private note') }])
    await publishAssistantPanelCollection(f.input)
  }
  expect(f.input.upload).not.toHaveBeenCalled()
  expect(f.rows.get('memory:note')).toMatchObject({ body_item_id: 'body',data: { checkedAt: 20 } })
})

it('never discards a reused body when a metadata save loses a revision race', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.upload.mockClear()
  f.input.collect.mockResolvedValue([{ key: 'note',data: { relativePath: 'note.md',checkedAt: 1 },bytes: new TextEncoder().encode('private note') }])
  f.deleteWhileUploading()
  await publishAssistantPanelCollection(f.input)
  expect(f.input.upload).not.toHaveBeenCalled()
  expect(f.input.discard).not.toHaveBeenCalled()
  expect(f.input.revoke).toHaveBeenCalledOnce()
})

it('latches a post-upload validation failure until the resource bytes change', async () => {
  const f = transport()
  f.input.upload.mockRejectedValue(new AssistantPanelError('invalid-body','not a file'))
  await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: 'invalid-body' })
  expect(f.failures.get('memory:note')).toMatchObject({ code: 'invalid-body' })
  f.input.upload.mockClear()
  for (let checkedAt = 1; checkedAt <= 20; checkedAt++) {
    f.input.collect.mockResolvedValue([{ key: 'note',data: { checkedAt },bytes: new TextEncoder().encode('private note') }])
    await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: 'invalid-body' })
  }
  expect(f.input.upload).not.toHaveBeenCalled()
  expect(f.calls.filter(change => change.operation === 'error')).toHaveLength(1)
  f.input.collect.mockResolvedValue([{ key: 'note',data: {},bytes: new TextEncoder().encode('changed') }])
  f.input.upload.mockResolvedValue({ itemId: 'changed-body',sha256: createHash('sha256').update('changed').digest('hex') })
  await publishAssistantPanelCollection(f.input)
  expect(f.input.upload).toHaveBeenCalledOnce()
  expect(f.failures.size).toBe(0)
})

it('discards only the new mismatched body and suppresses its next unchanged upload', async () => {
  const f = transport()
  f.input.upload.mockResolvedValue({ itemId: 'wrong-body',sha256: 'b'.repeat(64) })
  await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: 'invalid-body' })
  await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: 'invalid-body' })
  expect(f.input.upload).toHaveBeenCalledOnce()
  expect(f.input.discard).toHaveBeenCalledExactlyOnceWith('wrong-body')
  expect(f.rows.has('memory:note')).toBe(false)
})

it('still publishes other resources when one unchanged body is latched as invalid', async () => {
  const f = transport()
  f.failures.set('memory:note',{ sha256: createHash('sha256').update('private note').digest('hex'),code: 'invalid-body' })
  f.input.collect.mockResolvedValue([
    { key: 'note',data: {},bytes: new TextEncoder().encode('private note') },
    { key: 'healthy',data: { title: 'Healthy' } },
  ])
  await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: 'invalid-body' })
  expect(f.input.upload).not.toHaveBeenCalled()
  expect(f.rows.get('memory:healthy')?.data.title).toBe('Healthy')
  expect(f.rows.get('memory:__collection__')?.data.state).toBe('error')
})

it('keeps the rejected hash across publisher restarts and forgets removed resources', async () => {
  const disk = await fixture(), f = transport()
  f.input.upload.mockRejectedValue(new AssistantPanelError('invalid-body','not a file'))
  await expect(publishAssistantPanelCollection({ ...f.input,bodyFailures: createAssistantPanelBodyFailures(disk.root,'owner','assistant') })).rejects.toMatchObject({ code: 'invalid-body' })
  f.input.upload.mockClear()
  for (let checkedAt = 1; checkedAt <= 5; checkedAt++) {
    f.input.collect.mockResolvedValue([{ key: 'note',data: { checkedAt },bytes: new TextEncoder().encode('private note') }])
    await expect(publishAssistantPanelCollection({ ...f.input,bodyFailures: createAssistantPanelBodyFailures(disk.root,'owner','assistant') })).rejects.toMatchObject({ code: 'invalid-body' })
  }
  expect(f.input.upload).not.toHaveBeenCalled()
  f.input.collect.mockResolvedValue([])
  await publishAssistantPanelCollection({ ...f.input,bodyFailures: createAssistantPanelBodyFailures(disk.root,'owner','assistant') })
  expect(await createAssistantPanelBodyFailures(disk.root,'owner','assistant').get('memory','note')).toBeUndefined()
})

it.each(['broken-json','future-format','unreadable'])('publishes normally with an ignored %s suppression cache', async kind => {
  const disk = await fixture(), f = transport()
  const failure = { sha256: 'a'.repeat(64),code: 'invalid-body' as const }
  await createAssistantPanelBodyFailures(disk.root,'owner','assistant').set('memory','old',failure)
  const folder = join(disk.root,'assistant-panel-body-failures'), [name] = await readdir(folder), path = join(folder,name)
  if (kind === 'unreadable') { await rm(path); await mkdir(path) }
  else await writeFile(path,kind === 'broken-json' ? '{broken' : JSON.stringify({ version: 99 }))
  const journal = createAssistantPanelBodyFailures(disk.root,'owner','assistant')
  for (const domain of ['memory','integrations'] as const) await expect(publishAssistantPanelCollection({ ...f.input,domain,bodyFailures: journal })).resolves.toBeUndefined()
  expect(f.rows.get('memory:note')?.body_item_id).toBe('body')
  expect(f.rows.get('integrations:note')?.body_item_id).toBe('body')
  // A later persistence attempt replaces bad content. Failed writes remain a
  // disposable-cache problem too, without losing the in-memory suppression.
  await expect(journal.set('memory','new',failure)).resolves.toBeUndefined()
  expect(await journal.get('memory','new')).toEqual(failure)
  expect(cacheLog.warn).toHaveBeenCalledOnce()
  if (kind !== 'unreadable') expect(await createAssistantPanelBodyFailures(disk.root,'owner','assistant').get('memory','new')).toEqual(failure)
})

it('retries a transport failure without recording it as an invalid body', async () => {
  const f = transport()
  f.input.upload.mockRejectedValueOnce(new TypeError('network unavailable'))
  await expect(publishAssistantPanelCollection(f.input)).rejects.toThrow('network unavailable')
  expect(f.failures.size).toBe(0)
  await publishAssistantPanelCollection(f.input)
  expect(f.input.upload).toHaveBeenCalledTimes(2)
  expect(f.rows.get('memory:note')?.body_item_id).toBe('body')
})

it.each(['file','document'])('executes attachment upload/place once when the backend returns kind=%s', async kind => {
  vi.stubEnv('GUGU_SUPABASE_URL','http://127.0.0.1:12345')
  vi.stubEnv('GUGU_SUPABASE_ANON_KEY','fixture')
  const requests = vi.spyOn(globalThis,'fetch').mockImplementation(async url => {
    if (String(url).endsWith('/attachments/upload')) return Response.json({ staging_key: 'staging',url: 'http://127.0.0.1:12345/store',fields: {},max_bytes: 4096 })
    if (String(url).endsWith('/store')) return new Response(null,{ status: 204 })
    if (String(url).endsWith('/attachments/place')) return Response.json({ item: { id: 'stored-body',kind } })
    throw new Error('Unexpected request')
  })
  const f = transport(), disk = await fixture()
  const bytes = new TextEncoder().encode(JSON.stringify({ providerId: 'dingtalk',name: 'Example' }))
  f.input.upload.mockImplementation(row => uploadAssistantPanelBody({ ownerId: 'owner',accountId: () => 'owner',token: 'fixture',chatId: 'private-chat',
    label: 'account',bytes: row.bytes! }))
  for (let checkedAt = 0; checkedAt < 20; checkedAt++) {
    f.input.collect.mockResolvedValue([{ key: 'note',data: { checkedAt },bytes }])
    // New journal instance each sweep also exercises recovery from a host restart.
    const publication = publishAssistantPanelCollection({ ...f.input,bodyFailures: createAssistantPanelBodyFailures(disk.root,'owner','assistant') })
    if (kind === 'file') await publication
    else await expect(publication).rejects.toMatchObject({ code: 'invalid-body' })
  }
  expect(f.input.upload).toHaveBeenCalledOnce()
  expect(requests).toHaveBeenCalledTimes(3)
})

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

it('records a rejected first publication as error even when the error marker loses a version race', async () => {
  const f = transport(), original = f.input.cloud.commit.getMockImplementation()!
  let conflict = true
  f.input.cloud.commit.mockImplementation(async (assistant,change) => {
    if (change.operation === 'save') throw new AssistantPanelError('22023','Invalid observation')
    if (change.operation === 'error' && conflict) {
      conflict = false
      await original(assistant,{ ...change,operationId: 'concurrent-marker',operation: 'prepared',data: { state: 'ready',schemaVersion: 1,itemCount: 0 } })
      throw new AssistantPanelError('40001','Marker changed')
    }
    return original(assistant,change)
  })
  await expect(publishAssistantPanelCollection(f.input)).rejects.toMatchObject({ code: '22023' })
  expect(f.rows.has('memory:note')).toBe(false)
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

it('keeps the collection readable when an owner edit wins while a body is uploading', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.collect.mockResolvedValue([{ key: 'note',data: { relativePath: 'note.md',title: 'Local observation' },bytes: new TextEncoder().encode('old local observation') }])
  f.input.upload.mockImplementation(async () => {
    const row = f.rows.get('memory:note')!
    f.rows.set('memory:note',{ ...row,revision: '100',data: { relativePath: 'note.md',title: 'Owner saved this' } })
    return { itemId: 'late-body',sha256: createHash('sha256').update('old local observation').digest('hex') }
  })
  await expect(publishAssistantPanelCollection(f.input)).resolves.toBeUndefined()
  expect(f.rows.get('memory:note')?.data.title).toBe('Owner saved this')
  expect(f.rows.get('memory:__collection__')?.data.state).toBe('ready')
  expect(f.input.discard).toHaveBeenCalledWith('late-body')
})

it('does not interpret a missing previously published file root as an empty collection', async () => {
  const f = transport(), disk = await fixture()
  await publishAssistantPanelCollection(f.input)
  f.input.collect.mockImplementation(async (baseline = []) => collectAssistantPanelFiles(disk.binding,'memory',undefined,{ requireRoot: baseline.length > 0 }))
  await expect(publishAssistantPanelCollection(f.input)).rejects.toThrow('PANEL_RESOURCE_ROOT_MISSING')
  expect(f.rows.get('memory:note')?.deleted_at).toBeNull()
})

it('reconciles an observed local value after an owner edit has terminally failed', async () => {
  const f = transport()
  await publishAssistantPanelCollection(f.input)
  f.input.collect.mockResolvedValue([{ key: 'note', data: { relativePath: 'note.md',title: 'actual local value' } }])
  f.input.cloud.snapshot.mockImplementation(async () => ({ version: 1,revision: '9',items: [...f.rows.values()],application: [
    { operationId: 'rejected-edit',revision: '9',domain: 'memory',resourceKey: 'note',status: 'failed',errorCode: 'EACCES',terminal: true },
  ] }))
  await publishAssistantPanelCollection(f.input)
  expect(f.rows.get('memory:note')?.data.title).toBe('actual local value')
  expect(f.rows.get('memory:__collection__')?.data.state).toBe('ready')
})
