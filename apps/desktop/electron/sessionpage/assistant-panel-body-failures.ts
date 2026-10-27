import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core/local/state/paths'
import type { AssistantPanelDomain } from '@gugu/core/cloud/assistantPanel'
import { createLogger } from '../lib/logger'

const log = createLogger('assistant-panel-body-failures')

type Failure = { sha256: string; code: 'invalid-body' }
function validFailure(row: unknown): row is [string, Failure] {
  if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[1]
    || typeof row[1].sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row[1].sha256) || row[1].code !== 'invalid-body') return false
  try {
    const key = JSON.parse(row[0])
    return Array.isArray(key) && key.length === 2 && key.every(value => typeof value === 'string')
  } catch { return false }
}
export type AssistantPanelBodyFailures = {
  get(domain: AssistantPanelDomain,key: string): Promise<Failure | undefined>
  set(domain: AssistantPanelDomain,key: string,failure: Failure): Promise<void>
  clear(domain: AssistantPanelDomain,key: string): Promise<void>
  retain(domain: AssistantPanelDomain,keys: ReadonlySet<string>): Promise<void>
}

/** No bodies or credentials: only the last rejected content hash per resource.
 * Keep this across host restarts so a bad attachment response cannot fill the
 * private folder again on every inventory sweep. */
export function createAssistantPanelBodyFailures(guguHome: string,owner: string,assistant: string): AssistantPanelBodyFailures {
  const id = createHash('sha256').update(JSON.stringify([owner,assistant])).digest('hex')
  const path = join(guguHome,'assistant-panel-body-failures',`${id}.json`)
  const entries = new Map<string, Failure>()
  let loaded: Promise<void> | undefined, tail: Promise<unknown> = Promise.resolve()
  let warned = false
  // Once per journal: the reason is an error code or name, never the file's content.
  function warn(operation: 'read' | 'write',error: unknown) {
    if (warned) return
    warned = true
    // A SyntaxError's message quotes the file, so it is reported by kind only.
    const reason = (error as NodeJS.ErrnoException | undefined)?.code
      ?? (error instanceof SyntaxError ? 'invalid-json' : error instanceof Error ? error.message : 'unknown')
    log.warn({ operation,reason },'Panel upload suppression cache unavailable; publication continues with in-memory records')
  }
  async function load() {
    if (!loaded) loaded = (async () => {
      let text: string
      try { text = await readFile(path,'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      const state = JSON.parse(text)
      if (!state || state.version !== 1 || state.owner !== owner || state.assistant !== assistant || !Array.isArray(state.failures)
        || !state.failures.every(validFailure)) {
        throw new Error('PANEL_BODY_FAILURE_STATE_INVALID')
      }
      for (const [key,failure] of state.failures) entries.set(key,failure)
    })().catch((error: unknown) => { entries.clear(); warn('read',error) })
    await loaded
  }
  const serial = <T>(work: () => Promise<T> | T): Promise<T> => {
    const next = tail.catch(() => undefined).then(load).then(work)
    tail = next; return next
  }
  const keyOf = (domain: AssistantPanelDomain,key: string) => JSON.stringify([domain,key])
  const save = () => atomicWriteText(path,JSON.stringify({ version: 1,owner,assistant,failures: [...entries] })).catch((error: unknown) => warn('write',error))
  return {
    get: (domain,key) => serial(() => entries.get(keyOf(domain,key))),
    set: (domain,key,failure) => serial(async () => { entries.set(keyOf(domain,key),failure); await save() }),
    clear: (domain,key) => serial(async () => { if (entries.delete(keyOf(domain,key))) await save() }),
    retain: (domain,keys) => serial(async () => {
      let changed = false
      for (const key of entries.keys()) {
        const [storedDomain,resource] = JSON.parse(key)
        if (storedDomain === domain && !keys.has(resource)) { entries.delete(key); changed = true }
      }
      if (changed) await save()
    }),
  }
}
