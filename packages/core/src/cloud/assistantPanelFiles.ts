import { parseMemoryNote } from '../shared/assistantMemory'
import { queuedAssistantPanelBody } from './assistantPanelBodyQueue'
import { assistantPanelCollection, AssistantPanelError, type AssistantPanelClient, type AssistantPanelDomain, type AssistantPanelItem } from './assistantPanel'
import { splitInstructions } from '../shared/assistantInstructions'
import { withAssistantPanelReadDeadline } from './assistantPanelRead'
import type { AssistantPanelReadCache } from './assistantPanelCache'

export const ASSISTANT_PANEL_PATHS = {
  instructions: '性格约定',memoryDir: '记忆',claudeMemoryDir: '记忆',memoryIndex: '记忆/MEMORY.md',
  resourcesDir: '给助理的资料',skillsDir: '技能',settings: '设置',
}
export type AssistantPanelFileEntry = { path: string; name: string; type: 'directory' | 'file'; size: number; modifiedAt: Date }
const roots: Array<[AssistantPanelDomain, string]> = [['voice-notes','记忆/voice-notes'],['memory','记忆'],['files','给助理的资料'],['skills','技能']]
const relativePath = (item: AssistantPanelItem) => item.domain === 'memory' ? item.data.relativePath : item.domain === 'files' ? item.data.path
  : item.domain === 'skills' ? `${item.resource_key}/SKILL.md` : item.resource_key
function checked(path: string): string {
  if (!path || /(^[/~]|[\\:%]|(^|\/)\.{1,2}(\/|$)|\/\/|\/$)/.test(path)
    || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new AssistantPanelError('invalid-path','Invalid panel resource path')
  return path
}
function route(path: string) {
  checked(path)
  if (path === ASSISTANT_PANEL_PATHS.instructions) return { domain: 'personality' as const,relative: 'instructions',root: path }
  for (const [domain,root] of roots) if (path === root || path.startsWith(`${root}/`)) return { domain,root,relative: path.slice(root.length).replace(/^\//,'') }
  throw new AssistantPanelError('invalid-path','Unknown panel resource path')
}

/** A cloud file view for the existing desktop and phone components. Its paths
 * are logical resource names; execution paths are resolved only by the host. */
export function createAssistantPanelFiles(input: {
  assistantId: string; deviceId: string; ownerId: string; cloud: AssistantPanelClient
  assertCurrent(): void | Promise<void>
  readBody(item: AssistantPanelItem, signal?: AbortSignal): Promise<Uint8Array>
  upload(name: string, bytes: Uint8Array): Promise<{ itemId: string; sha256: string }>
  discard(itemId: string): Promise<void>
  changed(): void
  cache?: AssistantPanelReadCache
}) {
  let cached: { at: number; value: ReturnType<AssistantPanelClient['snapshot']> } | null = null
  const versions = new Map<string, string>()
  const bodies = new Map<string, Uint8Array>()
  const openedIntegrationBodies = new Set<string>()
  let bodyBytes = 0
  const peekSnapshot = () => input.cache?.peekSnapshot()
  const bodyKey = (item: AssistantPanelItem) => `${item.body_item_id}:${item.body_sha256}`
  const bodyIsCurrent = (item: AssistantPanelItem) => {
    const latest = peekSnapshot()
    return !latest || latest.items.some(row => row.domain === item.domain && row.resource_key === item.resource_key && bodyKey(row) === bodyKey(item))
  }
  const peekBody = (item: AssistantPanelItem) => bodyIsCurrent(item) ? input.cache?.peekBody(item) : undefined
  const invalidate = () => { cached = null; input.changed(); if (input.cache) void snapshot().catch(() => undefined) }
  let warming = false, warmAgain = false
  async function warmBodies() {
    if (!input.cache) return
    if (warming) { warmAgain = true; return }
    warming = true
    try { do {
      warmAgain = false
      const missing = (peekSnapshot()?.items ?? []).filter(item => item.body_item_id
        && (['capabilities','device-notes'].includes(item.domain) || item.domain === 'integrations' && openedIntegrationBodies.has(item.resource_key)) && !peekBody(item))
      let next = 0
      await Promise.all(Array.from({length:Math.min(4,missing.length)},async () => {
        while (next < missing.length) {
          const item = missing[next++]!
          try { await body(item); input.changed() } catch { /* An optional background fill never blocks a list. */ }
        }
      }))
    } while (warmAgain) } finally { warming = false }
  }
  async function snapshot() {
    await input.assertCurrent()
    if (!cached || Date.now() - cached.at > 1000) cached = { at: Date.now(),value: withAssistantPanelReadDeadline(() => input.cloud.snapshot(input.assistantId)) }
    const current = cached
    try {
      const result = await current.value
      await input.assertCurrent()
      // An application directory never starts catalog downloads. Once a detail
      // was opened, keep that persisted copy current on later cloud changes.
      for (const item of peekSnapshot()?.items ?? []) if (item.domain === 'integrations' && peekBody(item)) openedIntegrationBodies.add(item.resource_key)
      input.cache?.saveSnapshot(result)
      const live = new Set(result.items.filter(row => row.body_item_id).map(row => `${row.body_item_id}:${row.body_sha256}`))
      for (const [key,value] of bodies) if (!live.has(key)) { bodies.delete(key); bodyBytes -= value.length }
      void warmBodies()
      return result
    } catch (error) { if (cached === current) cached = null; throw error }
  }
  const collectionStates = new Map<AssistantPanelDomain, 'ready' | 'unprepared' | 'error'>()
  async function collection(domain: AssistantPanelDomain) {
    const current = await snapshot()
    const result = assistantPanelCollection(current,domain,['tasks','capabilities','device-notes','integrations'].includes(domain) ? input.deviceId : undefined)
    collectionStates.set(domain,result.state)
    const failed = current.application.find(row => row.domain === domain && row.status === 'failed')
    if (failed) throw new AssistantPanelError('application-failed','PANEL_APPLICATION_FAILED',failed.resourceKey,domain)
    if (result.items.some(item => item.stale_at)) throw new AssistantPanelError('stale','PANEL_RESOURCE_STALE',undefined,domain)
    if (result.state !== 'ready' && !(domain === 'voice-notes' && result.state === 'unprepared' && result.items.length > 0)) throw new AssistantPanelError(result.state === 'unprepared' ? 'unprepared' : 'collection-unavailable',
      result.state === 'unprepared' ? 'This collection has not been prepared yet' : 'This collection could not be read')
    return result.items
  }
  async function find(path: string, requireReady = true) {
    const target = route(path)
    const rows = requireReady ? await collection(target.domain) : (await snapshot()).items.filter(row => row.domain === target.domain)
    const item = rows.find(row => target.domain === 'personality' ? row.resource_key === 'instructions' : relativePath(row) === target.relative)
    if (item) versions.set(path,item.revision)
    return { ...target,item,rows }
  }
  async function bytes(path: string) {
    const target = route(path)
    const { item,domain } = await find(path,target.domain !== 'voice-notes')
    if (!item) return null
    if (domain === 'personality' && typeof item.data.text === 'string') return new TextEncoder().encode(item.data.text)
    const latest = await input.cloud.resource(input.assistantId,domain,item.resource_key)
    if (!latest || latest.deleted_at) return null
    const result = await body(latest)
    await input.assertCurrent()
    versions.set(path,latest.revision)
    return result
  }
  async function body(item: AssistantPanelItem) {
    await input.assertCurrent()
    if (!bodyIsCurrent(item)) throw new AssistantPanelError('missing','PANEL_RESOURCE_REMOVED')
    if (item.domain === 'integrations') openedIntegrationBodies.add(item.resource_key)
    const key = `${item.body_item_id}:${item.body_sha256}`
    const cached = peekBody(item) ?? bodies.get(key)
    if (cached) return cached.slice()
    const result = await queuedAssistantPanelBody(`${input.ownerId}:${input.assistantId}:${key}`,signal => input.readBody(item,signal))
    await input.assertCurrent()
    if (!bodyIsCurrent(item)) throw new AssistantPanelError('missing','PANEL_RESOURCE_REMOVED')
    input.cache?.saveBody(item,result)
    if (!bodies.has(key) && result.length <= 32 * 1024 * 1024) {
      while (bodyBytes + result.length > 32 * 1024 * 1024 && bodies.size) {
        const oldest = bodies.keys().next().value!
        bodyBytes -= bodies.get(oldest)!.length; bodies.delete(oldest)
      }
      bodies.set(key,result.slice()); bodyBytes += result.length
    }
    return result
  }
  async function commit(item: AssistantPanelItem | undefined, domain: AssistantPanelDomain, key: string,
    operation: 'save' | 'remove' | 'enable' | 'disable',data: Record<string, unknown>,body?: { itemId: string; sha256: string },expectedRevision?: string) {
    await input.assertCurrent()
    const change = { operationId: crypto.randomUUID(),domain,key,operation,data,body,deviceId: input.deviceId,
      expectedRevision: expectedRevision ?? item?.revision ?? '0' }
    let error: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const receipt = await input.cloud.commit(input.assistantId,change)
        if (operation === 'remove') input.cache?.forget(domain,key,receipt.revision)
        invalidate()
        return receipt
      } catch (failure) {
        error = failure
        if (['40001','42501','55000','22023','54000'].includes(String((failure as { code?: string }).code))) break
      }
    }
    if (body) await input.discard(body.itemId).catch(() => undefined)
    throw error
  }
  async function write(path: string, value: Uint8Array, contentType: string, expectedRevision?: string) {
    const { item,domain,relative } = await find(path,false)
    if (!relative) throw new AssistantPanelError('invalid-path','A resource name is required')
    const name = relative.split('/').pop()!
    if (domain === 'personality') {
      const text = splitInstructions(new TextDecoder('utf-8',{ fatal: true }).decode(value)).user
      await commit(item,domain,'instructions','save',{ text },undefined,expectedRevision)
      return
    }
    const key = item?.resource_key ?? (domain === 'voice-notes' ? relative : domain === 'skills' ? relative.replace(/\/SKILL\.md$/,'') : relative)
    const modifiedAt = new Date().toISOString()
    const memory = domain === 'memory' ? parseMemoryNote(name,new TextDecoder().decode(value)) : null
    const data = domain === 'memory' ? { relativePath: relative,title: memory!.title,modifiedAt,kind: relative === 'owner-profile.md' ? 'user' : memory!.kind }
      : domain === 'files' ? { name,path: relative,kind: 'file',contentType,sizeBytes: value.length,modifiedAt }
      : domain === 'skills' ? { name: key,modifiedAt } : { noteId: relative.split('/')[0],kind: name }
    const body = await input.upload(name,value)
    const previous = item ?? await input.cloud.resource(input.assistantId,domain,key) ?? undefined
    await commit(previous,domain,key,'save',data,body,expectedRevision)
  }
  async function list(path: string): Promise<AssistantPanelFileEntry[]> {
    const { domain,relative,root } = route(path)
    const rows = await collection(domain)
    const entries = new Map<string, AssistantPanelFileEntry>()
    for (const item of rows) {
      const name = relativePath(item)
      if (typeof name !== 'string') throw new AssistantPanelError('invalid-response','Resource path is missing')
      checked(name)
      const prefix = relative ? `${relative}/` : ''
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (!rest) continue
      const child = rest.split('/')[0]!, folder = rest.includes('/') || item.data.kind === 'directory'
      const path = `${root}/${prefix}${child}`
      entries.set(child,{ name: child,path,type: folder ? 'directory' : 'file',size: folder ? 0 : Number(item.data.sizeBytes ?? 0),
        modifiedAt: new Date(typeof item.data.modifiedAt === 'string' ? item.data.modifiedAt : item.updated_at) })
    }
    // Voice notes are a separate complete collection inside the memory view.
    if (domain === 'memory' && !relative) {
      const voice = assistantPanelCollection(await snapshot(),'voice-notes')
      if (voice.state === 'ready' && voice.items.length) entries.set('voice-notes',{ name: 'voice-notes',path: `${root}/voice-notes`,type: 'directory',size: 0,modifiedAt: new Date(0) })
    }
    return [...entries.values()].sort((a,b) => a.name.localeCompare(b.name))
  }
  return {
    assistantId: input.assistantId,ownerId: input.ownerId,deviceId: input.deviceId,paths: ASSISTANT_PANEL_PATHS,snapshot,peekSnapshot,peekBody,collection,invalidate,list,bytes,
    assertCurrent: input.assertCurrent,
    body,
    collectionState: (domain: AssistantPanelDomain) => collectionStates.get(domain),
    async change(item: AssistantPanelItem, operation: 'remove' | 'enable' | 'disable') {
      return commit(item,item.domain,item.resource_key,operation,{})
    },
    async save(item: AssistantPanelItem, data: Record<string, unknown>) {
      return commit(item,item.domain,item.resource_key,'save',data,item.body_item_id && item.body_sha256 ? { itemId: item.body_item_id,sha256: item.body_sha256 } : undefined)
    },
    async put(domain: AssistantPanelDomain, key: string, data: Record<string, unknown>, value: Uint8Array, expectedRevision: string) {
      const current = (await snapshot()).items.find(row => row.domain === domain && row.resource_key === key)
      const body = await input.upload(key,value)
      return commit(current,domain,key,'save',data,body,expectedRevision)
    },
    revision: (path: string) => versions.get(path),
    async text(path: string) { const value = await bytes(path); return value ? new TextDecoder('utf-8',{ fatal: true }).decode(value) : null },
    write,
    async remove(path: string, recursive = false) {
      const { item,domain,relative,rows } = await find(path)
      const targets = rows.filter(row => row === item || recursive && typeof relativePath(row) === 'string' && String(relativePath(row)).startsWith(`${relative}/`))
        .sort((a,b) => String(relativePath(b)).length - String(relativePath(a)).length)
      for (const row of targets) await commit(row,domain,row.resource_key,'remove',{})
    },
    async mkdir(path: string) {
      const { item,domain,relative } = await find(path,false)
      if (!relative || item) return
      if (domain !== 'files' && domain !== 'voice-notes') throw new AssistantPanelError('invalid-path','This collection does not contain folders')
      const key = relative
      const previous = await input.cloud.resource(input.assistantId,domain,key) ?? undefined
      await commit(previous,domain,key,'save',domain === 'files' ? { name: relative.split('/').pop(),path: relative,kind: 'directory' }
        : { noteId: relative.split('/')[0],kind: 'directory' })
    },
    async rename(path: string, name: string) {
      checked(name)
      if (name.includes('/')) throw new AssistantPanelError('invalid-path','A single file name is required')
      const { domain,relative,item,rows } = await find(path)
      if (!item || !['memory','files'].includes(domain)) throw new AssistantPanelError('unavailable','The resource no longer exists')
      const next = [...relative.split('/').slice(0,-1),name].join('/')
      if (rows.some(row => relativePath(row) === next && row !== item)) throw new AssistantPanelError('exists','A resource with this name already exists')
      const targets = rows.filter(row => row === item || item.data.kind === 'directory' && String(relativePath(row)).startsWith(`${relative}/`))
      for (const row of targets.sort((a,b) => String(relativePath(b)).length - String(relativePath(a)).length)) {
        const newPath = next + String(relativePath(row)).slice(relative.length)
        await commit(row,domain,row.resource_key,'save',{ ...row.data,...(domain === 'memory' ? { relativePath: newPath } : { path: newPath,name: newPath.split('/').pop() }) },
          row.body_item_id && row.body_sha256 ? { itemId: row.body_item_id,sha256: row.body_sha256 } : undefined)
      }
    },
  }
}
export type AssistantPanelFiles = ReturnType<typeof createAssistantPanelFiles>
