import { parseMemoryNote,memoryIndexHints,readFrontmatter } from '@gugu/core/shared/assistantMemory'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { splitInstructions } from '@gugu/core/shared/assistantInstructions'
import type { AssistantPanelClient, AssistantPanelDomain, AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelHome } from './assistant-panel-application'
import type { AssistantPanelBodyFailures } from './assistant-panel-body-failures'
import { assistantPanelPath } from './assistant-panel-paths'

export type PanelObservation = { key: string; data: Record<string, unknown>; bytes?: Uint8Array }
const deviceDomains: readonly AssistantPanelDomain[] = ['tasks','capabilities','device-notes','integrations']
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => `${JSON.stringify(key)}:${stable(value)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Only natural host activity calls this publisher. A complete collection is
 * marked ready after all rows converge; failures retain the prior rows and
 * explicitly change its marker to error. */
export async function publishAssistantPanelCollection(input: {
  assistantId: string; instanceId: string; deviceId: string; domain: AssistantPanelDomain; cloud: Pick<AssistantPanelClient, 'resource' | 'snapshot' | 'commit'>
  bodyFailures: AssistantPanelBodyFailures
  collect(previous: AssistantPanelItem[]): Promise<PanelObservation[]>
  upload(observation: PanelObservation): Promise<{ itemId: string; sha256: string }>
  discard(itemId: string): Promise<void>
  revoke(item: AssistantPanelItem, observation: PanelObservation): Promise<void>
}): Promise<void> {
  const scoped = deviceDomains.includes(input.domain)
  const markerKey = scoped ? `__collection__:${input.deviceId}` : '__collection__'
  async function commit(key: string, expectedRevision: string, operation: 'save' | 'remove' | 'prepared' | 'error', data: Record<string, unknown>, body?: { itemId: string; sha256: string }) {
    const change = { operationId: randomUUID(),domain: input.domain,key,expectedRevision,operation,data,body,
      deviceId: input.deviceId,runtimeInstanceId: input.instanceId }
    // A lost response must retry the same operation, never create a second one.
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await input.cloud.commit(input.assistantId,change) }
      catch (error) {
        failure = error
        if (['PT409','42501','55000','22023','54000'].includes(String((error as { code?: string }).code))) throw error
      }
    }
    throw failure
  }
  try {
    // Capture authority before reading local files. A later owner edit must
    // never be overwritten by an older observation of the same resource.
    const baseline = await input.cloud.snapshot(input.assistantId)
    const revisions = new Map(baseline.items.filter(row => row.domain === input.domain).map(row => [row.resource_key,row.revision]))
    const pending = new Set(baseline.application.filter(row => row.domain === input.domain && !row.terminal).map(row => row.resourceKey))
    const records = await input.collect(baseline.items.filter(row => row.domain === input.domain && !row.resource_key.startsWith('__collection__')))
    if (new Set(records.map(row => row.key)).size !== records.length) throw new Error('PANEL_DUPLICATE_RESOURCE')
    await input.bodyFailures.retain(input.domain,new Set(records.map(row => row.key)))
    const seen = new Set<string>()
    let invalidBody: unknown
    for (const row of records) {
      seen.add(row.key)
      const current = await input.cloud.resource(input.assistantId,input.domain,row.key)
      if (current?.deleted_at) { await input.revoke(current,row); continue }
      if (pending.has(row.key) || (current?.revision ?? '0') !== (revisions.get(row.key) ?? '0')) continue
      const digest = row.bytes ? sha256(row.bytes) : undefined
      const reused = digest && current?.body_item_id && current.body_sha256 === digest
        ? { itemId: current.body_item_id,sha256: digest } : undefined
      if (!digest || reused) await input.bodyFailures.clear(input.domain,row.key)
      if (current && !current.stale_at && stable(current.data) === stable(row.data)
        && (row.bytes ? reused : current.body_item_id === null)) continue
      let body = reused, uploaded = false
      try {
        if (digest && !body) {
          const rejected = await input.bodyFailures.get(input.domain,row.key)
          if (rejected?.sha256 === digest) throw new AssistantPanelError(rejected.code,'Panel body validation previously failed',row.key,input.domain)
          if (rejected) await input.bodyFailures.clear(input.domain,row.key)
          try {
            body = await input.upload(row); uploaded = true
            if (!body.itemId || body.sha256 !== digest) throw new AssistantPanelError('invalid-body','Panel upload did not match observed bytes',row.key,input.domain)
          } catch (error) {
            if ((error as { code?: string }).code === 'invalid-body') await input.bodyFailures.set(input.domain,row.key,{ sha256: digest,code: 'invalid-body' })
            throw error
          }
        }
        await commit(row.key,current?.revision ?? '0','save',row.data,body)
        await input.bodyFailures.clear(input.domain,row.key)
      } catch (error) {
        if (uploaded && body) await input.discard(body.itemId).catch(() => undefined)
        // A deletion which won the version race must also remove the local copy.
        const latest = await input.cloud.resource(input.assistantId,input.domain,row.key)
        if (latest?.deleted_at) { await input.revoke(latest,row); continue }
        if (['PT409','55000'].includes(String((error as { code?: string }).code))) continue
        if ((error as { code?: string }).code === 'invalid-body') { invalidBody ??= error; continue }
        throw error
      }
    }
    const snapshot = await input.cloud.snapshot(input.assistantId)
    for (const previous of snapshot.items.filter(row => row.domain === input.domain && !row.resource_key.startsWith('__collection__')
      && (!scoped || row.device_id === input.deviceId) && !seen.has(row.resource_key))) {
      if (pending.has(previous.resource_key) || revisions.get(previous.resource_key) !== previous.revision) continue
      try { await commit(previous.resource_key,previous.revision,'remove',{}) }
      catch (error) { if (!['PT409','55000'].includes(String((error as { code?: string }).code))) throw error }
    }
    const latest = await input.cloud.snapshot(input.assistantId)
    if (invalidBody) throw invalidBody
    const count = latest.items.filter(row => row.domain === input.domain && !row.resource_key.startsWith('__collection__')
      && (!scoped || row.device_id === input.deviceId)).length
    const marker = await input.cloud.resource(input.assistantId,input.domain,markerKey)
    const data = { state: 'ready',schemaVersion: 1,itemCount: count }
    if (marker?.stale_at || stable(marker?.data) !== stable(data)) {
      try { await commit(markerKey,marker?.revision ?? '0','prepared',data) }
      catch (error) { if (!['PT409','55000'].includes(String((error as { code?: string }).code))) throw error }
    }
  } catch (error) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const marker = await input.cloud.resource(input.assistantId,input.domain,markerKey)
        const data = { state: 'error',schemaVersion: 1,errorCode: 'RESOURCE_PUBLICATION_FAILED' }
        if (marker && !marker.stale_at && stable(marker.data) === stable(data)) break
        await commit(markerKey,marker?.revision ?? '0','error',data)
        break
      } catch (failure) {
        // Retry only the marker's version race with a fresh revision. A
        // transport/authorization failure is covered by the bounded reader.
        if (String((failure as { code?: string }).code) !== 'PT409') break
      }
    }
    throw error
  }
}

/** Complete file bodies, including nested folders. Symlinks and changing files
 * are errors, rather than an apparently complete empty/partial inventory. */
export async function collectAssistantPanelFiles(binding: AssistantPanelHome, domain: 'memory' | 'files' | 'skills' | 'personality' | 'voice-notes',
  identify: (domain: AssistantPanelDomain, path: string) => Promise<string> = async (_domain,path) => path, options: { requireRoot?: boolean } = {}): Promise<PanelObservation[]> {
  const paths = assistantHomePaths(binding.home,binding.cwd,binding.kind)
  const anchor = binding.kind === 'cloud' ? binding.home : binding.cwd
  if (domain === 'personality') {
    let text: string
    const target = await assistantPanelPath(dirname(paths.instructions),'CLAUDE.md',{ home: anchor })
    try { text = await readFile(target,'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; text = '' }
    return [{ key: 'instructions',data: { text: splitInstructions(text).user } }]
  }
  const root = domain === 'memory' ? paths.memoryDir : domain === 'files' ? paths.resourcesDir
    : domain === 'skills' ? paths.skillsDir : `${paths.memoryDir}/voice-notes`
  const result: PanelObservation[] = []
  await assistantPanelPath(root,'__panel_probe__',{ home: anchor })
  async function walk(relative: string) {
    let entries
    try { entries = await readdir(relative ? await assistantPanelPath(root,relative,{ home: anchor }) : root,{ withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!relative && options.requireRoot) throw new Error('PANEL_RESOURCE_ROOT_MISSING');
      if (relative) throw new Error('PANEL_RESOURCE_CHANGED');
      return }
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || domain === 'memory' && !relative && entry.name === 'voice-notes') continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error('PANEL_RESOURCE_SYMLINK')
      const target = await assistantPanelPath(root,path,{ home: anchor })
      const before = await stat(target)
      const key = await identify(domain,path)
      if (entry.isDirectory()) {
        if (domain === 'files') result.push({ key,data: { name: entry.name,path,kind: 'directory',modifiedAt: before.mtime.toISOString() } })
        if (domain === 'voice-notes') result.push({ key,data: { noteId: path.split('/')[0],kind: 'directory' } })
        await walk(path)
      } else if (entry.isFile()) {
        if (domain === 'skills' && (!relative || entry.name !== 'SKILL.md')) continue
        const bytes = new Uint8Array(await readFile(target))
        const after = await stat(target)
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('PANEL_RESOURCE_CHANGED')
        const modifiedAt = after.mtime.toISOString()
        const data = domain === 'files' ? { name: entry.name,path,kind: 'file',sizeBytes: bytes.length,modifiedAt }
          : domain === 'memory' ? { relativePath: path,title: entry.name,modifiedAt,kind: 'file' }
          : domain === 'skills' ? { name: relative,modifiedAt }
          : { noteId: path.split('/')[0],kind: entry.name }
        result.push({ key: domain === 'skills' ? relative : key,data,bytes })
      }
    }
  }
  await walk('')
  if (domain === 'memory') {
    const index = result.find(row => row.data.relativePath === 'MEMORY.md')
    const hints = memoryIndexHints(index?.bytes ? new TextDecoder().decode(index.bytes) : '')
    for (const row of result) {
      const path = String(row.data.relativePath)
      const note = parseMemoryNote(path,new TextDecoder().decode(row.bytes),hints.get(path))
      row.data = { ...row.data,title: note.title,kind: path === 'owner-profile.md' ? 'user' : note.kind }
    }
  }
  if (domain === 'skills') for (const row of result) {
    const { fields } = readFrontmatter(new TextDecoder().decode(row.bytes))
    row.data = { ...row.data,name: fields.name || row.key,description: fields.description ?? '' }
  }
  return result
}
