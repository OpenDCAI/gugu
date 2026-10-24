import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { ASSISTANT_INDEX_LIMIT, boundedAssistantIndex } from './assistant-index-format'
import { assistantStartupIndex, type AssistantStartupIndexDeps } from './assistant-startup-index'
import { createLogger } from '../lib/logger'
import { startupDiscovery } from './startup-discovery'

type Snapshot = { account: string; cwd: string; kind: AssistantHomeKind; observedAt: string; index: string }
const refreshing = new Map<string, Promise<void>>()
const log = createLogger('assistant-index')

/** Discovery is data, not the tool surface. Never hold the first model request for remote inventories. */
export async function openingAssistantIndex(
  guguHome: string, cwd: string, kind: AssistantHomeKind, deps: AssistantStartupIndexDeps,
): Promise<{ index: string; refreshed: Promise<void> }> {
  const account = await deps.accountId()
  if (!account) throw new Error('Assistant startup index: owner is not authenticated')
  const directory = resolve(cwd)
  const key = createHash('sha256').update(JSON.stringify({ account, cwd: directory, kind })).digest('hex')
  const path = join(guguHome, 'assistant-context', `${key}.json`)
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
    const refresh = startupDiscovery.schedule(async () => {
      const index = await assistantStartupIndex(deps)
      if (await deps.accountId() !== account) throw new Error('Assistant startup index: account changed before saving')
      const value: Snapshot = { account, cwd: directory, kind, observedAt: (deps.now?.() ?? new Date()).toISOString(), index }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
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
