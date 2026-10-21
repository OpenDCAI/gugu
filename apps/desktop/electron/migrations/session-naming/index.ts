// 名字层(PR-2)的段 2:存着的 JSON 里与库外文件里的旧键名、旧值,跟上新代码的词。
//
// 段 1(`drizzle/0033_session_naming.sql`)改的是库的骨架:表名、列名、索引、自动化运行的状态与 step、
// `app_settings` 的行键 `tasks`、kv 前缀 `taskpage-platform-model:`。这里做骨架之外的那些:
//   1. 库里存着的 JSON(一个事务,全成或全不成):
//      · kv `view-state:*`:侧栏三个键、项目页的 `taskViewTab`、导航的 `new-task` 视图、每条会话的 tab 布局
//        (tab 种类 `conversation` → `session`,聊天类 / 审阅 tab 的 `conversationId` → `sessionId`,
//        浏览器 tab 的 `isolated-per-task` 档案 → `isolated-per-session`);
//      · `app_settings`:`keyboard` 里的动作名(含 owner 定的三对合并,见 KEYBOARD_MERGES)、`browser` 的默认档案;
//      · `project_settings.base_project_settings_json` 的两个 `autoRun*OnTaskCreation`;
//      · `sessions.config` 的 `forkedFrom.conversationId` 与 `startupOrigin: 'task-page'`;
//      · `automations.session_config` / `automation_runs.session_config_snapshot` 的 `taskConfig.initialConversation`。
//   2. 库外的五样(每个文件原子写,改过的才写):
//      · 名册 `agents.json` 每条 cache 里的 `taskpage_*` / `emdash_conversation_id` 键,与 surface 值 `task-tui` / `task-acp`;
//      · `<userData>/hook-sources.json` 每条记录的 `sessionId` → `ptySessionId`;
//      · `<GUGU_HOME>/platform-access/*.json` 平台票账本:`sessionId` → `accessSessionId`,再 `conversationId` → `sessionId`;
//      · `<claude 配置目录>/projects/*/.gugu-continuations/*.json`:`conversationId` → `sessionId`,
//        `sourceSessionId` / `continuationSessionId` → `sourceProviderSessionId` / `continuationProviderSessionId`;
//      · `<GUGU_HOME>/runtime-fork-ownership/*.json`:`sourceConversationId` / `forkedFromConversationId` → `*SessionId`。
//   3. 摘要写进 `<userData>/migrations/session-naming-v1.summary.json`,写 `.done`。
//
// 新代码只认新名字(读的时候不兼容旧名字),所以这一段必须赶在任何读者之前:调用方在 `runTaskToSessionOnce` 之后、
// 设置 / 名册 / 钩子服务 / 平台票结清起来之前 await 它。每一项都能重跑(旧键不在 = 已经改过);
// 有一项失败就不写 `.done`,整趟响亮上抛,下次启动重试。读不懂的 JSON 不归这里修:原样留着,记进摘要。
//
// 旧名字只许待在这个目录、0033 和 tests/migrations 里。等能直接升级上来的最低版本越过 0033,整个目录一起删。
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '@gugu/core'
import { listAgents, updateAgent, type LocalAgentRecord } from '@gugu/core/local/state/agents'
import { claudeTranscriptDirFor } from '../../session/main/core/sessions/fork-lineage'

export const DONE_FILE = 'session-naming-v1.done'
export const SUMMARY_FILE = 'session-naming-v1.summary.json'

export interface SessionNamingDeps {
  db: Database.Database
  userData: string
  /** 名册、平台票账本、分叉归属所在;默认 = 产品自己的 resolveGuguHome(process.env)。 */
  guguHome?: string
  /** claude 的 `projects` 目录;默认与 fork-lineage.ts 的 claudeTranscriptDirFor 同一个算法。 */
  claudeProjectsDir?: string
  roster?: {
    list: () => Promise<LocalAgentRecord[]>
    setCache: (agent: LocalAgentRecord, cache: Record<string, unknown>) => Promise<void>
  }
}

export interface SessionNamingSummary {
  db: {
    viewState: number
    keyboard: {
      renamed: number
      /** 被删掉的三个动作(`taskNext` / `taskPrev` / `pinTask`)上自定义的键,搬到了留下的那个动作上。 */
      merged: Array<{ from: string; to: string }>
      /** 没搬、丢掉的:留下的那个动作也自定义过(以它为准),或者用户只是把被删的那个解绑了。 */
      dropped: Array<{ from: string; to: string; reason: 'survivor-customized' | 'unbound' }>
    }
    browserDefaultProfile: number
    projectSettings: number
    sessionConfigs: number
    automations: number
    automationRuns: number
    /** JSON 读不懂的行:没动。 */
    unreadable: string[]
  }
  files: {
    roster: number
    hookSources: number
    accessLedger: number
    continuations: number
    forkOwnership: number
    /** JSON 读不懂的文件:没动。 */
    unreadable: string[]
  }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 旧键在才动;新键已经在 = 以新的为准,旧的丢掉。返回动没动。 */
function renameKey(record: unknown, from: string, to: string): boolean {
  if (!isObject(record) || !(from in record)) return false
  if (!(to in record)) record[to] = record[from]
  delete record[from]
  return true
}

function renameKeys(record: unknown, pairs: ReadonlyArray<readonly [string, string]>): boolean {
  let changed = false
  for (const [from, to] of pairs) changed = renameKey(record, from, to) || changed
  return changed
}

function replaceValue(record: unknown, key: string, from: string, to: string): boolean {
  if (!isObject(record) || record[key] !== from) return false
  record[key] = to
  return true
}

// ── 库里的 JSON ──────────────────────────────────────────────────────────────────────────────────────────────────

const OLD_ISOLATED_PROFILE = 'isolated-per-task'
const NEW_ISOLATED_PROFILE = 'isolated-per-session'
/** tab 状态里装着会话 id 的那几种(聊天三种 + 审阅)。 */
const SESSION_TAB_KINDS = new Set(['session', 'acp-chat', 'side-chat', 'review'])

function migrateTab(tab: unknown): boolean {
  if (!isObject(tab)) return false
  let changed = replaceValue(tab, 'kind', 'conversation', 'session')
  if (typeof tab.kind === 'string' && SESSION_TAB_KINDS.has(tab.kind)) changed = renameKey(tab, 'conversationId', 'sessionId') || changed
  if (tab.kind === 'browser') changed = replaceValue(tab.session, 'profileId', OLD_ISOLATED_PROFILE, NEW_ISOLATED_PROFILE) || changed
  return changed
}

/** `…:tabs` 与旧的整份视图状态里,tab 都装在某个 `tabManager.tabs` 里(分组的、单格的、旧单格的),一处一处找。 */
function migrateTabsIn(value: unknown): boolean {
  if (Array.isArray(value)) return value.map(migrateTabsIn).some(Boolean)
  if (!isObject(value)) return false
  let changed = false
  if (isObject(value.tabManager) && Array.isArray(value.tabManager.tabs)) {
    for (const tab of value.tabManager.tabs) changed = migrateTab(tab) || changed
  }
  for (const [key, child] of Object.entries(value)) if (key !== 'tabManager') changed = migrateTabsIn(child) || changed
  return changed
}

/** 键名决定形状(`view-state:<名字>`,见 view-state-service)。 */
function migrateViewState(value: Json, key: string): boolean {
  if (key === 'view-state:sidebar') {
    return renameKeys(value, [['expandedConversationIds', 'expandedSessionIds'], ['taskSortBy', 'sessionSortBy'], ['tasksCollapsed', 'sessionsCollapsed']])
  }
  if (key === 'view-state:navigation') {
    const view = replaceValue(value, 'currentViewId', 'new-task', 'new-session')
    return renameKey(value.viewParams, 'new-task', 'new-session') || view
  }
  if (key.startsWith('view-state:project:')) return renameKey(value, 'taskViewTab', 'sessionViewTab')
  if (key.startsWith('view-state:session:')) return migrateTabsIn(value)
  return false
}

/**
 * 改名的动作:旧键 → 新键,值原样。会话行上的 ⌃X 两次从删除改成了归档(#6949),改绑过的键跟着搬到归档那一个;
 * 「删除选中的任务」从来没接上动作,键位表里删了,旧键随之丢掉。
 */
const KEYBOARD_RENAMES = [
  ['newTask', 'newSession'],
  ['archiveTask', 'archiveSession'],
  ['sideTask', 'sideSession'],
  ['renameConversation', 'renameSession'],
  ['pinConversation', 'pinSession'],
  ['deleteConversation', 'archiveHighlightedSession'],
] as const
/**
 * 删掉的动作 → 留下的那个(owner 2026-10-05:同一件事两个默认键,留 Mod+↑↓ 与侧栏的置顶)。
 * 自定义过的键搬到留下的那个上;留下的那个也自定义过 = 以它为准,被删的丢掉;只是解绑(null)= 丢掉
 * —— 搬过去等于把用户没碰过的那个动作也解绑了。改名先做,合并才看得见 `pinConversation` 已经成了 `pinSession`。
 */
const KEYBOARD_MERGES = [
  ['taskNext', 'sessionNext'],
  ['taskPrev', 'sessionPrev'],
  ['pinTask', 'pinSession'],
] as const

function migrateKeyboard(bindings: Json, summary: SessionNamingSummary['db']['keyboard']): boolean {
  let changed = false
  for (const [from, to] of KEYBOARD_RENAMES) {
    if (!renameKey(bindings, from, to)) continue
    summary.renamed += 1
    changed = true
  }
  for (const [from, to] of KEYBOARD_MERGES) {
    if (!(from in bindings)) continue
    const binding = bindings[from]
    delete bindings[from]
    changed = true
    if (binding === null || binding === undefined) summary.dropped.push({ from, to, reason: 'unbound' })
    else if (to in bindings) summary.dropped.push({ from, to, reason: 'survivor-customized' })
    else {
      bindings[to] = binding
      summary.merged.push({ from, to })
    }
  }
  return changed
}

/** `automations.session_config` 与运行快照是同一种文档:`{ version, taskConfig: { …, initialConversation }, workspaceConfig }`。 */
function migrateStoredSessionConfig(config: Json): boolean {
  let changed = renameKey(config, 'taskConfig', 'sessionConfig')
  const sessionConfig = config.sessionConfig
  changed = renameKey(sessionConfig, 'initialConversation', 'initialSession') || changed
  if (isObject(sessionConfig)) changed = replaceValue(sessionConfig.initialSession, 'startupOrigin', 'task-page', 'session-page') || changed
  return changed
}

function migrateSessionRowConfig(config: Json): boolean {
  const lineage = renameKey(config.forkedFrom, 'conversationId', 'sessionId')
  return replaceValue(config, 'startupOrigin', 'task-page', 'session-page') || lineage
}

type Row = { id: string; value: string | null }

function migrateDatabase(db: Database.Database, summary: SessionNamingSummary['db']): void {
  /** 一列 JSON 一行一行改:读不懂的记下、不动;改过的才写回。返回改了几行。 */
  const rewrite = (label: string, select: string, update: string, apply: (value: Json, id: string) => boolean): number => {
    const write = db.prepare(update)
    let count = 0
    for (const row of db.prepare(select).all() as Row[]) {
      if (row.value === null) continue
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch {
        summary.unreadable.push(`${label}:${row.id}`)
        continue
      }
      if (!isObject(value) || !apply(value, row.id)) continue
      write.run(JSON.stringify(value), row.id)
      count += 1
    }
    return count
  }
  db.transaction(() => {
    summary.viewState = rewrite('kv', `SELECT key AS id, value FROM kv WHERE key LIKE 'view-state:%'`,
      'UPDATE kv SET value = ? WHERE key = ?', migrateViewState)
    rewrite('app_settings', `SELECT key AS id, value FROM app_settings WHERE key = 'keyboard'`,
      'UPDATE app_settings SET value = ? WHERE key = ?', (value) => migrateKeyboard(value, summary.keyboard))
    summary.browserDefaultProfile = rewrite('app_settings', `SELECT key AS id, value FROM app_settings WHERE key = 'browser'`,
      'UPDATE app_settings SET value = ? WHERE key = ?',
      (value) => replaceValue(value, 'defaultProfileId', OLD_ISOLATED_PROFILE, NEW_ISOLATED_PROFILE))
    summary.projectSettings = rewrite('project_settings', 'SELECT project_id AS id, base_project_settings_json AS value FROM project_settings',
      'UPDATE project_settings SET base_project_settings_json = ? WHERE project_id = ?',
      (value) => renameKeys(value, [['autoRunSetupScriptOnTaskCreation', 'autoRunSetupScriptOnSessionCreation'], ['autoRunRunScriptOnTaskCreation', 'autoRunRunScriptOnSessionCreation']]))
    summary.sessionConfigs = rewrite('sessions.config', 'SELECT id, config AS value FROM sessions',
      'UPDATE sessions SET config = ? WHERE id = ?', migrateSessionRowConfig)
    summary.automations = rewrite('automations.session_config', 'SELECT id, session_config AS value FROM automations',
      'UPDATE automations SET session_config = ? WHERE id = ?', migrateStoredSessionConfig)
    summary.automationRuns = rewrite('automation_runs.session_config_snapshot', 'SELECT id, session_config_snapshot AS value FROM automation_runs',
      'UPDATE automation_runs SET session_config_snapshot = ? WHERE id = ?', migrateStoredSessionConfig)
  })()
}

// ── 库外的文件 ───────────────────────────────────────────────────────────────────────────────────────────────────

const ROSTER_KEYS = [
  ['emdash_conversation_id', 'emdash_session_id'],
  ['taskpage_parked_conversation_id', 'sessionpage_parked_session_id'],
  ['taskpage_group_chat_id', 'sessionpage_group_chat_id'],
  ['taskpage_direct_chat_id', 'sessionpage_direct_chat_id'],
  ['taskpage_provider_id', 'sessionpage_provider_id'],
  ['taskpage_session_surface', 'sessionpage_session_surface'],
  ['taskpage_owner_user_id', 'sessionpage_owner_user_id'],
  ['taskpage_cloud_identity_state', 'sessionpage_cloud_identity_state'],
] as const
const SURFACES: Record<string, string> = { 'task-tui': 'tui', 'task-acp': 'acp' }

async function migrateRoster(roster: NonNullable<SessionNamingDeps['roster']>): Promise<number> {
  let count = 0
  for (const agent of await roster.list()) {
    if (!agent.cache) continue
    const cache: Json = { ...agent.cache }
    let changed = renameKeys(cache, ROSTER_KEYS)
    const surface = cache.sessionpage_session_surface
    if (typeof surface === 'string' && surface in SURFACES) {
      cache.sessionpage_session_surface = SURFACES[surface]
      changed = true
    }
    if (!changed) continue
    await roster.setCache(agent, cache)
    count += 1
  }
  return count
}

const defaultRoster: NonNullable<SessionNamingDeps['roster']> = {
  list: () => listAgents(process.env, { includeGuests: true }),
  setCache: async (agent, cache) => {
    const providerSessionId = typeof agent.cache?.provider_session_id === 'string' ? agent.cache.provider_session_id : ''
    if (agent.gugu_user_id) await updateAgent({ guguUserId: agent.gugu_user_id }, { cache })
    else if (providerSessionId) await updateAgent({ providerSessionId }, { cache })
    else throw new Error(`roster record '${agent.name}' has neither identity nor session id`)
  },
}

/** 一个 JSON 文件:不在 = 0;读不懂 = 记下、不动;改过才原子写回(0600,与这些文件自己的写法一致)。 */
async function rewriteJsonFile(path: string, apply: (value: Json) => boolean, unreadable: string[]): Promise<number> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    unreadable.push(path)
    return 0
  }
  if (!isObject(value) || !apply(value)) return 0
  await atomicWriteText(path, `${JSON.stringify(value)}\n`)
  return 1
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => join(dir, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function rewriteJsonFiles(paths: string[], apply: (value: Json) => boolean, unreadable: string[]): Promise<number> {
  let count = 0
  for (const path of paths) count += await rewriteJsonFile(path, apply, unreadable)
  return count
}

/**
 * 平台票账本里 `sessionId` 换了意思(从票的 id 变成咕咕会话的 id),所以只改旧形状的文件:有 `accessSessionId`
 * 的已经是新的 —— 再跑一遍 `sessionId` → `accessSessionId` 会把会话 id 当成票 id 丢掉。
 */
function migrateLedgerEntry(entry: Json): boolean {
  if ('accessSessionId' in entry) return false
  return renameKeys(entry, [['sessionId', 'accessSessionId'], ['conversationId', 'sessionId']])
}

async function continuationFiles(projectsDir: string): Promise<string[]> {
  let projects: string[]
  try {
    projects = await readdir(projectsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const project of projects) files.push(...await jsonFilesIn(join(projectsDir, project, '.gugu-continuations')))
  return files
}

/** 上一次迁移(task → session)留下的整库备份。同一时刻只留一份:新的这份写好、核过之后删掉它。 */
export const PREVIOUS_BACKUP_FILE = 'gugu4.pre-session.db'

/**
 * 0033 之前整库备份(同 task-to-session 的 backupBeforeTaskToSession):旧版本打不开改过名的库,这份是回退的路。
 * 只在 `conversations` 表还在(= 0033 还没跑)时做;`tasks` 表也在 = 这次连 0032 一起跑,task-to-session 那份备份
 * 已经是迁移前的状态,不再备第二份。`gugu4.pre-session-naming.db` 已经在就不覆盖。在 `initializeDatabase()` 之前调。
 *
 * 备份只留一份(一份就是整个库,owner 的机器上 830MB):新备份写好并且 quick_check 过了,才删上一次迁移那份;
 * 核不过就不落新的、旧的照留,响亮上抛。
 */
export async function backupBeforeSessionNaming(db: Database.Database, dbPath: string): Promise<string | null> {
  const table = (name: string) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
  if (!table('conversations') || table('tasks')) return null
  const dest = join(dirname(dbPath), 'gugu4.pre-session-naming.db')
  if (existsSync(dest)) return null
  const tmp = `${dest}.${process.pid}.tmp`
  await db.backup(tmp)
  // 副本跟真库一样是 WAL:只读连接关掉时删不掉它自己建的 `-shm` / `-wal`,改名之后它们就成了孤儿;读写连接是最后一个,关时自己收掉
  const copy = new Database(tmp)
  let check: unknown
  try {
    check = copy.pragma('quick_check', { simple: true })
  } finally {
    copy.close()
  }
  if (check !== 'ok') {
    await rm(tmp, { force: true })
    throw new Error(`session-naming: the backup before 0033 failed quick_check (${String(check)}); kept ${PREVIOUS_BACKUP_FILE}`)
  }
  await rename(tmp, dest)
  await rm(join(dirname(dbPath), PREVIOUS_BACKUP_FILE), { force: true })
  return dest
}

// ── 入口 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 跑一次段 2。`.done` 在 = 已完成,返回 null。失败策略:各项都跑完再响亮上抛,❌ 写 `.done`。
 * 调用方:`runTaskToSessionOnce` 之后、任何读设置 / 视图状态 / 名册 / 钩子凭据 / 平台票账本之前 await 它。
 */
export async function runSessionNamingOnce(deps: SessionNamingDeps): Promise<SessionNamingSummary | null> {
  const dir = join(deps.userData, 'migrations')
  const donePath = join(dir, DONE_FILE)
  if (existsSync(donePath)) return null
  const guguHome = deps.guguHome ?? resolveGuguHome(process.env)
  // fork-lineage 的 `<配置目录>/projects/<slug>`,去掉 slug 就是 projects 目录。
  const projectsDir = deps.claudeProjectsDir ?? dirname(claudeTranscriptDirFor('-'))
  const summary: SessionNamingSummary = {
    db: {
      viewState: 0,
      keyboard: { renamed: 0, merged: [], dropped: [] },
      browserDefaultProfile: 0,
      projectSettings: 0,
      sessionConfigs: 0,
      automations: 0,
      automationRuns: 0,
      unreadable: [],
    },
    files: { roster: 0, hookSources: 0, accessLedger: 0, continuations: 0, forkOwnership: 0, unreadable: [] },
  }
  const failures: string[] = []
  const step = async (label: string, run: () => unknown) => {
    try {
      await run()
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const { unreadable } = summary.files
  await step('database', () => migrateDatabase(deps.db, summary.db))
  await step('roster', async () => { summary.files.roster = await migrateRoster(deps.roster ?? defaultRoster) })
  await step('hook sources', async () => {
    summary.files.hookSources = await rewriteJsonFile(join(deps.userData, 'hook-sources.json'), (value) =>
      Array.isArray(value.records) && value.records.map((record) => renameKey(record, 'sessionId', 'ptySessionId')).some(Boolean), unreadable)
  })
  await step('platform access ledger', async () => {
    summary.files.accessLedger = await rewriteJsonFiles(await jsonFilesIn(join(guguHome, 'platform-access')), migrateLedgerEntry, unreadable)
  })
  await step('provider continuations', async () => {
    summary.files.continuations = await rewriteJsonFiles(await continuationFiles(projectsDir), (value) => renameKeys(value, [
      ['conversationId', 'sessionId'],
      ['sourceSessionId', 'sourceProviderSessionId'],
      ['continuationSessionId', 'continuationProviderSessionId'],
    ]), unreadable)
  })
  await step('runtime fork ownership', async () => {
    summary.files.forkOwnership = await rewriteJsonFiles(await jsonFilesIn(join(guguHome, 'runtime-fork-ownership')), (value) => renameKeys(value, [
      ['sourceConversationId', 'sourceSessionId'],
      ['forkedFromConversationId', 'forkedFromSessionId'],
    ]), unreadable)
  })
  if (failures.length > 0) {
    // 摘要只在成功那一趟落盘;库那一半这一趟已经提交了(下一趟读到的是新键,计数为 0),所以这一趟的计数随错误一起记下。
    throw new Error(`session-naming segment 2 failed (${failures.length}), will retry next start: ${failures.join('; ')}; this attempt: ${JSON.stringify(summary)}`)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SUMMARY_FILE), `${JSON.stringify({ completedAt: new Date().toISOString(), ...summary }, null, 2)}\n`, 'utf8')
  // 原子写:半截 .done 会被当成「已完成」。
  const tmp = `${donePath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ migration: 'session naming v1', completedAt: new Date().toISOString(), summary: SUMMARY_FILE }, null, 2)}\n`, 'utf8')
  await rename(tmp, donePath)
  return summary
}
