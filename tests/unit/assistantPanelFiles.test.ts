import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createAssistantPanelClient, type AssistantPanelDomain, type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'

function fixture() {
  let owner = 'owner', revision = 0, lose = false
  const application: unknown[] = []
  const rows = new Map<string, AssistantPanelItem>(), bodies = new Map<string, Uint8Array>()
  const receipts = new Map<string, unknown>(), operations: string[] = []
  const put = (domain: AssistantPanelDomain,key: string,data: Record<string, unknown>) => {
    const row: AssistantPanelItem = { owner_user_id: 'owner',assistant_user_id: 'assistant',domain,resource_key: key,
      device_id: 'home',revision: String(++revision),data,body_item_id: null,body_sha256: null,deleted_at: null,observed_at: null,updated_at: '2026-10-26T00:00:00Z' }
    rows.set(`${domain}:${key}`,row); return row
  }
  const cloud = createAssistantPanelClient(async (name,args) => {
    if (name === 'assistant_panel_snapshot') return { data: { version: 1,revision: String(revision),items: [...rows.values()].filter(row => !row.deleted_at),application },error: null }
    const key = `${args.p_domain}:${args.p_resource_key}`
    if (name === 'assistant_panel_resource') return { data: { version: 1,item: rows.get(key) ?? null },error: null }
    if (name !== 'assistant_panel_commit') throw new Error(name)
    const id = String(args.p_operation_id); operations.push(id)
    if (receipts.has(id)) return { data: receipts.get(id),error: null }
    const old = rows.get(key)
    if (String(args.p_expected_revision) !== (old?.revision ?? '0')) return { data: null,error: { code: 'PT409',message: 'Resource changed' } }
    const row = put(args.p_domain as AssistantPanelDomain,String(args.p_resource_key),args.p_data as Record<string, unknown>)
    row.body_item_id = args.p_body_item_id as string ?? null; row.body_sha256 = args.p_body_sha256 as string ?? null
    row.deleted_at = args.p_operation === 'remove' ? '2026-10-26' : null
    const receipt = { operationId: id,revision: row.revision,status: 'pending' }
    receipts.set(id,receipt)
    if (lose) { lose = false; throw new Error('Response lost') }
    return { data: receipt,error: null }
  },() => owner)
  const discard = vi.fn(async (id: string) => { bodies.delete(id) })
  const upload = vi.fn(async (_name: string,bytes: Uint8Array) => {
    const itemId = crypto.randomUUID(); bodies.set(itemId,bytes)
    return { itemId,sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const panel = createAssistantPanelFiles({ ownerId: owner,assistantId: 'assistant',deviceId: 'home',cloud,
    assertCurrent() { if (owner !== 'owner') throw new Error('Account changed') },
    readBody: async row => { const bytes = bodies.get(row.body_item_id!); if (!bytes) throw new Error('Body unavailable'); return bytes },
    upload,discard,changed: vi.fn(),
  })
  return { panel,rows,put,application,discard,upload,operations,loseNextResponse: () => { lose = true },switchOwner: () => { owner = 'other' } }
}

it('keeps unprepared, empty and failed collections distinct', async () => {
  const f = fixture()
  await expect(f.panel.list('记忆')).rejects.toMatchObject({ code: 'unprepared' })
  f.put('memory','__collection__',{ state: 'ready' }); f.panel.invalidate()
  expect(await f.panel.list('记忆')).toEqual([])
  f.put('memory','__collection__',{ state: 'error' }); f.panel.invalidate()
  await expect(f.panel.list('记忆')).rejects.toMatchObject({ code: 'collection-unavailable' })
})

it('keeps a returned unprepared state quiet indefinitely and recovers on publication', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    await expect(f.panel.collection('schedules')).rejects.toMatchObject({ code: 'unprepared' })
    await vi.advanceTimersByTimeAsync(15_001)
    await expect(f.panel.collection('schedules')).rejects.toMatchObject({ code: 'unprepared' })
    expect(f.panel.collectionState('schedules')).toBe('unprepared')
    f.put('schedules','__collection__',{ state: 'ready' }); f.panel.invalidate()
    expect(await f.panel.collection('schedules')).toEqual([])
    expect(f.panel.collectionState('schedules')).toBe('ready')
  } finally { vi.useRealTimers() }
})

it('shows a newly saved voice note before old-account backfill, without claiming a complete history', async () => {
  const f = fixture(); f.loseNextResponse()
  await f.panel.mkdir('记忆/voice-notes/new-note')
  await f.panel.write('记忆/voice-notes/new-note/note.json',new TextEncoder().encode('{"title":"New note"}'),'application/json')
  expect(f.operations[0]).toBe(f.operations[1])
  expect(await f.panel.text('记忆/voice-notes/new-note/note.json')).toBe('{"title":"New note"}')
  expect(await f.panel.text('记忆/voice-notes/new-note/summary.md')).toBeNull()
  expect(await f.panel.list('记忆/voice-notes')).toMatchObject([{ name: 'new-note',type: 'directory' }])
  expect(f.panel.collectionState('voice-notes')).toBe('unprepared')
  vi.useFakeTimers()
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await f.panel.list('记忆/voice-notes')).toHaveLength(1)
  } finally { vi.useRealTimers() }
  f.put('voice-notes','__collection__',{ state: 'error' }); f.panel.invalidate()
  await expect(f.panel.list('记忆/voice-notes')).rejects.toMatchObject({ code: 'collection-unavailable' })
})

it('uses one resource identity for concurrent same-path uploads and discards the losing upload', async () => {
  const f = fixture()
  f.put('files','__collection__',{ state: 'ready' })
  const results = await Promise.allSettled(['a','b'].map(value => f.panel.write('给助理的资料/file.txt',new TextEncoder().encode(value),'text/plain')))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(f.discard).toHaveBeenCalledOnce()
  expect(await f.panel.list('给助理的资料')).toHaveLength(1)
})

it('rejects a stale personality edit and rejects reads after switching accounts', async () => {
  const f = fixture()
  f.put('personality','__collection__',{ state: 'ready' })
  const original = f.put('personality','instructions',{ text: 'Original' }).revision
  expect(await f.panel.text('性格约定')).toBe('Original')
  f.put('personality','instructions',{ text: 'Another window' }); f.panel.invalidate()
  await expect(f.panel.write('性格约定',new TextEncoder().encode('Stale draft'),'text/plain',original)).rejects.toMatchObject({ code: 'PT409' })
  expect(await f.panel.text('性格约定')).toBe('Another window')
  f.switchOwner()
  await expect(f.panel.text('性格约定')).rejects.toThrow('Account changed')
})

it('refuses path escapes before any body upload', async () => {
  const f = fixture()
  for (const path of ['给助理的资料/../secret','给助理的资料/C:\\secret','/etc/x','记忆/%2e%2e/x']) {
    await expect(f.panel.write(path,new Uint8Array(),'text/plain')).rejects.toMatchObject({ code: 'invalid-path' })
  }
  expect(f.upload).not.toHaveBeenCalled()
})

it('allows an explicit new upload at a deleted path using the tombstone version and keeps stale drafts rejected', async () => {
  const f = fixture()
  f.put('files','__collection__',{ state: 'ready' })
  await f.panel.write('给助理的资料/file.txt',new TextEncoder().encode('old'),'text/plain')
  const old = f.rows.get('files:file.txt')!.revision
  await f.panel.remove('给助理的资料/file.txt')
  await f.panel.write('给助理的资料/file.txt',new TextEncoder().encode('new'),'text/plain')
  expect(await f.panel.text('给助理的资料/file.txt')).toBe('new')
  await expect(f.panel.write('给助理的资料/file.txt',new TextEncoder().encode('stale'),'text/plain',old)).rejects.toMatchObject({ code: 'PT409' })
})

it('reports stale and rejected host state instead of presenting it as current applied data', async () => {
  const f = fixture()
  f.put('personality','__collection__',{ state: 'ready' })
  const row = f.put('personality','instructions',{ text: 'Desired agreement' })
  row.stale_at = '2026-10-26'
  await expect(f.panel.text('性格约定')).rejects.toMatchObject({ code: 'stale' })
  row.stale_at = null; f.panel.invalidate()
  f.application.push({ operationId: 'failed',revision: row.revision,domain: 'personality',resourceKey: 'instructions',status: 'failed',errorCode: 'EACCES' })
  await expect(f.panel.text('性格约定')).rejects.toMatchObject({ code: 'application-failed',resourceKey: 'instructions' })
})

it('limits body downloads across file views to four and deduplicates the same saved body', async () => {
  let active=0,peak=0
  const release: Array<() => void>=[]
  const readBody=vi.fn(async () => {
    active++;peak=Math.max(peak,active)
    await new Promise<void>(resolve => release.push(resolve))
    active--;return new Uint8Array([1])
  })
  const f=fixture()
  const input={ownerId:'owner',assistantId:'assistant',deviceId:'home',cloud:{} as Parameters<typeof createAssistantPanelFiles>[0]['cloud'],assertCurrent:()=>{},readBody,upload:f.upload,discard:f.discard,changed:()=>{}}
  const a=createAssistantPanelFiles(input),b=createAssistantPanelFiles(input)
  const rows=Array.from({length:10},(_,i)=>({...f.put('files',String(i),{}),body_item_id:String(i),body_sha256:String(i)}))
  const pending=rows.map((row,i)=>(i%2?a:b).body(row))
  const duplicate=b.body(rows[0]!)
  await vi.waitFor(()=>expect(active).toBeGreaterThan(0))
  expect(peak).toBeLessThanOrEqual(4)
  while(release.length || active) { release.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setTimeout(resolve,0)) }
  await Promise.all([...pending,duplicate])
  expect(peak).toBeLessThanOrEqual(4)
  expect(readBody).toHaveBeenCalledTimes(10)
})
