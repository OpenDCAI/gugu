import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_INDEX_LIMIT, boundedAssistantIndex } from './assistant-index-format'
import { assistantStartupIndex, type AssistantStartupIndexDeps } from './assistant-startup-index'
import { createLogger } from '../lib/logger'
import { assistantResourceChanges, writeResourceOverflow } from './assistant-resource-changes'
import { startupDiscovery } from './startup-discovery'

type Snapshot = { account: string; cwd: string; kind: AssistantHomeKind; observedAt: string; index: string }
const refreshing = new Map<string, Promise<void>>()
const cacheGeneration = new Map<string, number>()
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>()
const cacheWrites = new Map<string, Promise<void>>()
const log = createLogger('assistant-index')

export function stopAssistantIndexRefresh(guguHome: string): void {
  const root = `${resolve(guguHome)}${sep}`
  for (const [path, timer] of refreshTimers) if (resolve(path).startsWith(root)) {
    clearInterval(timer); refreshTimers.delete(path)
  }
}

function mutateSnapshot(path: string, work: () => Promise<void>): Promise<void> {
  const result = (cacheWrites.get(path) ?? Promise.resolve()).catch(() => undefined).then(work)
  const settled = result.then(() => undefined,() => undefined)
  cacheWrites.set(path,settled)
  void settled.finally(() => { if (cacheWrites.get(path) === settled) cacheWrites.delete(path) })
  return result
}

function snapshotPath(guguHome: string, cwd: string, kind: AssistantHomeKind, account: string): string {
  const key = createHash('sha256').update(JSON.stringify({ account,cwd: resolve(cwd),kind })).digest('hex')
  return join(guguHome,'assistant-context',`${key}.json`)
}

/** Invalidates only the derived inventory cache. Native history and its prefix
 * remain intact; an older in-flight refresh cannot recreate the removed index. */
export async function invalidateAssistantIndex(guguHome: string, cwd: string, kind: AssistantHomeKind, account: string): Promise<void> {
  const path = snapshotPath(guguHome,cwd,kind,account)
  cacheGeneration.set(path,(cacheGeneration.get(path) ?? 0) + 1)
  refreshing.delete(path)
  await mutateSnapshot(path,() => rm(path,{ force: true }))
}

/** Discovery is data, not the tool surface. Never hold the first model request for remote inventories. */
export async function openingAssistantIndex(
  guguHome: string, cwd: string, kind: AssistantHomeKind, deps: AssistantStartupIndexDeps,
): Promise<{ index: string; refreshed: Promise<void> }> {
  const account = await deps.accountId()
  if (!account) throw new Error('Assistant startup index: owner is not authenticated')
  const directory = resolve(cwd)
  const path = snapshotPath(guguHome,cwd,kind,account)
  if (!refreshTimers.has(path)) {
    const timer = setInterval(() => {
      void deps.accountId().then(owner => {
        if (owner !== account) { clearInterval(timer); refreshTimers.delete(path); return }
        return openingAssistantIndex(guguHome, cwd, kind, deps).then(opening => opening.refreshed)
      }).catch(() => log.warn({}, 'Assistant resource refresh will retry'))
    }, 30_000)
    timer.unref(); refreshTimers.set(path, timer)
  }
  let cached: Snapshot | null = null
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Snapshot
    if (value.account === account && value.cwd === directory && value.kind === kind
      && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
      && typeof value.index === 'string' && value.index.length <= ASSISTANT_INDEX_LIMIT
      && value.index.startsWith('<gugu_resource_index>') && value.index.endsWith('</gugu_resource_index>')) cached = value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A damaged cache is not a successful empty inventory. The opening below says it is unknown.
      log.warn({}, 'Cached snapshot is unreadable; live discovery will refresh it')
    }
  }
  if (await deps.accountId() !== account) throw new Error('Assistant startup index: account changed before opening')
  if (!refreshing.has(path)) {
    const generation = cacheGeneration.get(path) ?? 0
    const refresh = startupDiscovery.schedule(async () => {
      const changes = assistantResourceChanges(guguHome, account)
      const revision = await changes.revision()
      const index = await assistantStartupIndex({ ...deps, overflow: async (index, observedOwner) => {
        if (observedOwner !== account || await deps.accountId() !== account) throw new Error('Assistant resource account changed')
        return writeResourceOverflow(guguHome, account, index)
      }, observed: async (lines, observedOwner) => {
        if (observedOwner !== account || await deps.accountId() !== account) throw new Error('Assistant resource account changed')
        return changes.observe(lines, revision)
      } })
      if (await deps.accountId() !== account) throw new Error('Assistant startup index: account changed before saving')
      const value: Snapshot = { account, cwd: directory, kind, observedAt: (deps.now?.() ?? new Date()).toISOString(), index }
      await mutateSnapshot(path,async () => {
        if ((cacheGeneration.get(path) ?? 0) !== generation) return
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
          await rename(temporary, path)
        } finally { await rm(temporary, { force: true }) }
      })
    }).catch(() => {
      log.warn({}, 'Background discovery failed; opening snapshot remains unverified')
    }).finally(() => { if (refreshing.get(path) === refresh) refreshing.delete(path) })
    refreshing.set(path, refresh)
  }
  const state = JSON.stringify({ source: 'assistant-opening-snapshot', status: cached ? 'cached' : 'not_loaded',
    observedAt: cached?.observedAt ?? null, refreshing: true,
    read: { devices: 'session_devices', actions: 'device_actions', projects: 'project_list', library: 'library_read' } })
  const note = '设备、项目等摘要在后台刷新；缓存不是当前在线或授权证明。使用前按读取入口核实，未载入不表示不存在。'
  const index = boundedAssistantIndex(cached
    ? ['<gugu_resource_index>', note, state, ...cached.index.split('\n').slice(1)]
    : ['<gugu_resource_index>', note, state,
      JSON.stringify({ account: `user:${account}`, execution_environment: process.env.GUGU_CLOUD_COMPUTER === '1' ? 'cloud' : 'user_device' }),
      '</gugu_resource_index>'])
  return { index, refreshed: refreshing.get(path)! }
}
