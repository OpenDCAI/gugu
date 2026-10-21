// task → session 迁移的段 2(notes/task-to-session/DESIGN.md §4.4):库外那几样东西。
//
// 段 1(`drizzle/0032_task_to_session.sql`)把库里能做的都做完,留下两张交接表:
//   · `legacy_task_map(task_id, project_id, task_type, session_id, is_scope_owner)` —— 每个旧 task 名下的会话;
//   · `legacy_task_orphans(task_id, kind, ref, stored_path, origin)` —— 名下一条会话都没有的 task 留下的
//     终端 / 附件 / 视图状态,库里没有地方归。
// 段 2 读完它们,做库外的那几件事,然后把两张表 DROP 掉、写 `.done`。从此任何地方都不再有 task 的痕迹。
//
// 旧模型的知识(旧的 pty id 形状、`emdash-` 旧前缀、名册里的 `emdash_task_id`)只许待在这个目录和 0032 里。
// 等能直接升级上来的最低版本越过 0032,整个目录连同 `gugu4.pre-session.db` 一起删(DESIGN §4.7、§9a-4)。
//
// 每一项都能安全重跑:中途崩了下次启动接着做;有一项失败就不 DROP、不写 `.done`,整趟响亮上抛,下次重试。
//   1. tmux 改名:`gugu-` / `gugubk-` / 旧 `emdash-` + base64url(<project>:<taskId>:<叶子>) → 新 pty id。
//      同一个编码段的 TUI 与后台**放进同一条 tmux 命令**改名 —— 启动时的 sweepOrphanTmuxBackends 只收
//      「找不到同名 TUI」的后台,改到一半被它看见就会被收掉。调用方还要先等那次 sweep 落定。
//   2. 名册 `agents.json`:删掉每条记录 cache 里的 `emdash_task_id`(新代码只认 `emdash_conversation_id`)。
//   3. 无主附件:origin='copy' 的文件挪进 `<userData>/migrations/task-to-session-orphans/<taskId>/`,❌ 删;
//      原地留着会被新的附件孤儿清扫(按「有没有行指着它」判)扫掉。origin='reference' 是用户自己的文件,只计数。
//   4. 内置浏览器「按会话隔离」的分区目录 `<userData>/Partitions/gugu-browser-isolated-<项目>-<工作区>-<taskId>`
//      (cookie、登录态都在里面)改名成 `…-<代表会话 id>`;改名前的 `emdash-browser-isolated-…` 一并直接改到新名字
//      (开机那次旧前缀搬迁排在段 2 之后,它不认会话)。新名字已在 = 两边都不动、记冲突。无主 task 的分区挪进孤儿目录。
//   5. App「始终用它」`<userData>/task-extensions/.open-with-defaults.json`:键 `task:<认领>` 改成 `session:<认领>`,值不动,
//      `group:` 的不碰(#6913 起读取器只认 session: / chat:,不认识的键读的时候就丢了:群文件的「始终用它」要重选一次,
//      owner 接受,不迁移)。
//   6. 摘要写进 `<userData>/migrations/task-to-session-v1.summary.json`,DROP 两张交接表,写 `.done`。
import type BetterSqlite3 from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { atomicWriteText } from '@gugu/core'
import { listAgents, updateAgent, type LocalAgentRecord } from '@gugu/core/local/state/agents'
import { makeTmuxSessionName, TMUX_SESSION_PREFIX } from '../../session/main/core/pty/tmux-session-name'
import { makePtySessionId } from '../../../src/session/shared/core/pty/ptySessionId'
import { BACKEND_SESSION_PREFIX, defaultTmuxBackendDeps } from '../../sessionpage/tmux-backend'

export const DONE_FILE = 'task-to-session-v1.done'
export const SUMMARY_FILE = 'task-to-session-v1.summary.json'
export const ORPHAN_DIR = 'task-to-session-orphans'
const LEGACY_TUI_PREFIX = 'emdash-'
const LEGACY_ROSTER_KEY = 'emdash_task_id'

export interface TaskToSessionDeps {
  db: BetterSqlite3.Database
  userData: string
  /** 跑一条 tmux 命令(已含 `-L` 套接字标签),回 stdout。 */
  tmux?: (args: string[]) => Promise<string>
  roster?: {
    list: () => Promise<LocalAgentRecord[]>
    setCache: (agent: LocalAgentRecord, cache: Record<string, unknown>) => Promise<void>
  }
}

export interface TaskToSessionSummary {
  sessions: number
  tasks: { total: number; standalone: number; withoutSession: number }
  /** `task_type='standalone'` 与「落在隐式主目录项目」两边各数一遍(DESIGN §4.8-2):不一致的那几条列出来。 */
  standaloneMismatch: { standaloneOutsideHome: string[]; homeNotStandalone: string[] }
  tmux: {
    renamed: Array<{ from: string; to: string }>
    /** scope 是一个旧 task,叶子却既不是它的会话也不是任何终端:留着不杀,交给回收器按它自己的规则处理。 */
    unrecognized: string[]
    /** 新名字已经被占:旧的留着不动。 */
    conflicts: Array<{ from: string; to: string }>
  }
  roster: { stripped: number }
  /** App「始终用它」(`task-extensions/.open-with-defaults.json`)里 `task:<认领>` 改成 `session:<认领>` 的条数;文件不在 = 0。 */
  openWithKeysRenamed: number
  browserPartitions: {
    renamed: Array<{ from: string; to: string }>
    conflicts: Array<{ from: string; to: string }>
    /** 名下没有会话的 task 的分区:挪进孤儿目录。 */
    orphaned: Array<{ from: string; movedTo: string }>
  }
  orphans: {
    terminals: string[]
    kv: string[]
    attachments: Array<{ taskId: string; id: string; storedPath: string; origin: string; movedTo: string | null; note?: string }>
  }
}

const IMPLICIT_HOME_PROJECT_ID = '00000000-0000-4000-8000-000000000001'

type MapRow = { task_id: string; project_id: string; task_type: string; session_id: string | null; is_scope_owner: number }
type OrphanRow = { task_id: string; kind: string; ref: string; stored_path: string | null; origin: string | null }

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

/** 旧前缀 + base64url(<project>:<scope>:<叶子>) → 三段;认不出(回环不等、不是三段)→ null。 */
function decodeLegacyName(name: string): { prefix: string; project: string; scope: string; leaf: string } | null {
  const prefix = [BACKEND_SESSION_PREFIX, TMUX_SESSION_PREFIX, LEGACY_TUI_PREFIX].find((p) => name.startsWith(p))
  if (!prefix) return null
  const encoded = name.slice(prefix.length)
  const id = Buffer.from(encoded, 'base64url').toString('utf8')
  if (!encoded || Buffer.from(id, 'utf8').toString('base64url') !== encoded) return null
  const parts = id.split(':')
  if (parts.length !== 3 || parts.some((part) => !part)) return null
  return { prefix, project: parts[0]!, scope: parts[1]!, leaf: parts[2]! }
}

async function listTmuxNames(tmux: (args: string[]) => Promise<string>): Promise<string[]> {
  try {
    return (await tmux(['list-sessions', '-F', '#{session_name}'])).split('\n').map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    // 没有 tmux / 没有 tmux 服务器 = 一个活会话都没有(读数);别的失败必须上抛 —— 当成空集就等于跳过改名还写 .done。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    const detail = `${(error as { stderr?: unknown }).stderr ?? ''} ${error instanceof Error ? error.message : String(error)}`
    if (/no server running|error connecting to .*\(No such file or directory\)/i.test(detail)) return []
    throw new Error(`task-to-session: cannot list tmux sessions: ${detail.trim()}`)
  }
}

async function renameTmuxSessions(
  db: BetterSqlite3.Database,
  map: MapRow[],
  tmux: (args: string[]) => Promise<string>,
  summary: TaskToSessionSummary,
  failures: string[],
): Promise<void> {
  const names = await listTmuxNames(tmux)
  if (names.length === 0) return
  const sessionsOfTask = new Map<string, Set<string>>()
  for (const row of map) {
    const set = sessionsOfTask.get(row.task_id) ?? new Set<string>()
    if (row.session_id) set.add(row.session_id)
    sessionsOfTask.set(row.task_id, set)
  }
  const terminalSession = db.prepare('SELECT session_id FROM terminals WHERE id = ?')
  const live = new Set(names)
  // 同一个编码段的那几个名字(TUI、后台、旧前缀 TUI)归成一组,一组一条 tmux 命令。
  const groups = new Map<string, Array<{ from: string; to: string }>>()
  for (const name of names) {
    const old = decodeLegacyName(name)
    // scope 不是旧 task(lifecycle 脚本按 workspaceId、草稿按 'draft')= 本来就是新格式,不碰。
    if (!old || !sessionsOfTask.has(old.scope)) continue
    let sessionId: string | null = null
    if (sessionsOfTask.get(old.scope)!.has(old.leaf)) sessionId = old.leaf
    else sessionId = (terminalSession.get(old.leaf) as { session_id: string } | undefined)?.session_id ?? null
    if (!sessionId) {
      summary.tmux.unrecognized.push(name)
      continue
    }
    const encoded = makeTmuxSessionName(makePtySessionId(old.project, sessionId, old.leaf)).slice(TMUX_SESSION_PREFIX.length)
    const to = `${old.prefix === BACKEND_SESSION_PREFIX ? BACKEND_SESSION_PREFIX : TMUX_SESSION_PREFIX}${encoded}`
    if (live.has(to)) {
      summary.tmux.conflicts.push({ from: name, to })
      continue
    }
    live.add(to)
    const group = groups.get(encoded) ?? []
    group.push({ from: name, to })
    groups.set(encoded, group)
  }
  for (const group of groups.values()) {
    // `=名字` = 精确匹配;不加 `=` 时 tmux 按前缀 / 通配找会话,可能改到别的会话上。
    const args = group.flatMap((pair, i) => [...(i ? [';'] : []), 'rename-session', '-t', `=${pair.from}`, pair.to])
    try {
      await tmux(args)
      summary.tmux.renamed.push(...group)
    } catch (error) {
      failures.push(`tmux rename ${group.map((pair) => pair.from).join(', ')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function stripRoster(roster: NonNullable<TaskToSessionDeps['roster']>, summary: TaskToSessionSummary, failures: string[]) {
  for (const agent of await roster.list()) {
    if (!agent.cache || !(LEGACY_ROSTER_KEY in agent.cache)) continue
    const { [LEGACY_ROSTER_KEY]: _dropped, ...rest } = agent.cache
    try {
      await roster.setCache(agent, rest)
      summary.roster.stripped += 1
    } catch (error) {
      failures.push(`roster ${agent.gugu_user_id || agent.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function keepOrphanAttachments(
  userData: string,
  rows: OrphanRow[],
  summary: TaskToSessionSummary,
  failures: string[],
): Promise<void> {
  for (const row of rows) {
    const storedPath = row.stored_path ?? ''
    const entry = { taskId: row.task_id, id: row.ref, storedPath, origin: row.origin ?? '', movedTo: null as string | null, note: undefined as string | undefined }
    summary.orphans.attachments.push(entry)
    // 'reference' 指向用户自己的文件:不归我们,❌ 挪。
    if (row.origin !== 'copy') continue
    const dest = join(userData, 'migrations', ORPHAN_DIR, row.task_id, `${row.ref}-${basename(storedPath)}`)
    try {
      if (existsSync(storedPath)) {
        await mkdir(dirname(dest), { recursive: true })
        await rename(storedPath, dest)
        entry.movedTo = dest
      } else if (existsSync(dest)) {
        entry.movedTo = dest // 上一趟已经挪过
      } else {
        entry.note = 'file already missing before migration'
      }
    } catch (error) {
      failures.push(`orphan attachment ${storedPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// 分区目录名 = 分区名去掉 `persist:`;各段是 uuid,`partitionComponent` 不改写它们(src/session/shared/browser.ts)。
const ISOLATED_PARTITION_PREFIXES = ['gugu-browser-isolated-', 'emdash-browser-isolated-']

async function moveBrowserPartitions(
  userData: string,
  map: MapRow[],
  summary: TaskToSessionSummary,
  failures: string[],
): Promise<void> {
  const partitionsDir = join(userData, 'Partitions')
  let names: string[]
  try {
    names = await readdir(partitionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    failures.push(`browser partitions: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const owner = new Map<string, string | null>()
  for (const row of map) {
    if (!owner.has(row.task_id)) owner.set(row.task_id, null)
    if (row.is_scope_owner && row.session_id) owner.set(row.task_id, row.session_id)
  }
  const present = new Set(names)
  for (const name of names) {
    const prefix = ISOLATED_PARTITION_PREFIXES.find((p) => name.startsWith(p))
    if (!prefix) continue
    const taskId = [...owner.keys()].find((id) => name.length > prefix.length + id.length && name.endsWith(`-${id}`))
    if (!taskId) continue
    const sessionId = owner.get(taskId)
    const from = join(partitionsDir, name)
    try {
      if (!sessionId) {
        const movedTo = join(userData, 'migrations', ORPHAN_DIR, taskId, `partition-${name}`)
        await mkdir(dirname(movedTo), { recursive: true })
        await rename(from, movedTo)
        summary.browserPartitions.orphaned.push({ from: name, movedTo })
        continue
      }
      const to = `${ISOLATED_PARTITION_PREFIXES[0]}${name.slice(prefix.length, name.length - taskId.length)}${sessionId}`
      if (present.has(to)) {
        summary.browserPartitions.conflicts.push({ from: name, to })
        continue
      }
      await rename(from, join(partitionsDir, to))
      present.add(to)
      summary.browserPartitions.renamed.push({ from: name, to })
    } catch (error) {
      failures.push(`browser partition ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * App 的「始终用它」按 `<场合>:<认领>` 记(`.open-with-defaults.json`,file-openers.ts `openWithKey`)。场合原来叫 `task`,
 * 现在叫 `session`;不改名的话新版读的时候会把这些键当成不认识的丢掉,人记下的选择就没了。只改键名,值一字不动;
 * 新名字已经在(重跑)就保留新的那条。和本目录其余各项一起删(本文件头:能直接升级上来的最低版本越过 0032 时)。
 */
async function renameOpenWithKeys(userData: string): Promise<number> {
  const path = join(userData, 'task-extensions', '.open-with-defaults.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const defaults = JSON.parse(text) as Record<string, unknown>
  let renamed = 0
  for (const key of Object.keys(defaults)) {
    if (!key.startsWith('task:')) continue
    const next = `session:${key.slice('task:'.length)}`
    if (!(next in defaults)) defaults[next] = defaults[key]
    delete defaults[key]
    renamed += 1
  }
  if (renamed > 0) await atomicWriteText(path, `${JSON.stringify(defaults, null, 2)}\n`)
  return renamed
}

/**
 * 跑一次段 2。`.done` 在 = 已完成,返回 null。失败策略:各项都跑完再响亮上抛,❌ 写 `.done`、❌ DROP 交接表。
 * 调用方:在 `initializeDatabase()` 之后、任何读会话 / 重连 tmux / 加载名册之前 await 它,并且先等启动时那次
 * `sweepOrphanTmuxBackends` 落定。
 */
export async function runTaskToSessionOnce(deps: TaskToSessionDeps): Promise<TaskToSessionSummary | null> {
  const dir = join(deps.userData, 'migrations')
  const donePath = join(dir, DONE_FILE)
  if (existsSync(donePath)) return null
  const { db } = deps
  const hasMap = tableExists(db, 'legacy_task_map')
  if (!hasMap) {
    // 0032 一定会建它(空库也建)。表不在而 .done 不在 = 上一趟 DROP 之后、写 .done 之前崩了,摘要已经落盘。
    await writeDone(donePath, { resumedAfterDrop: true })
    return null
  }
  const map = db.prepare('SELECT task_id, project_id, task_type, session_id, is_scope_owner FROM legacy_task_map').all() as MapRow[]
  const orphans = db.prepare('SELECT task_id, kind, ref, stored_path, origin FROM legacy_task_orphans ORDER BY task_id, kind, ref').all() as OrphanRow[]
  const tasks = new Map<string, MapRow>()
  for (const row of map) tasks.set(row.task_id, row)
  const summary: TaskToSessionSummary = {
    sessions: (db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n,
    tasks: {
      total: tasks.size,
      standalone: [...tasks.values()].filter((row) => row.task_type === 'standalone').length,
      withoutSession: map.filter((row) => !row.session_id).length,
    },
    standaloneMismatch: {
      standaloneOutsideHome: [...tasks.values()].filter((r) => r.task_type === 'standalone' && r.project_id !== IMPLICIT_HOME_PROJECT_ID).map((r) => r.task_id),
      homeNotStandalone: [...tasks.values()].filter((r) => r.task_type !== 'standalone' && r.project_id === IMPLICIT_HOME_PROJECT_ID).map((r) => r.task_id),
    },
    tmux: { renamed: [], unrecognized: [], conflicts: [] },
    roster: { stripped: 0 },
    openWithKeysRenamed: 0,
    browserPartitions: { renamed: [], conflicts: [], orphaned: [] },
    orphans: {
      terminals: orphans.filter((row) => row.kind === 'terminal').map((row) => row.ref),
      kv: orphans.filter((row) => row.kind === 'kv').map((row) => row.ref),
      attachments: [],
    },
  }
  const failures: string[] = []
  try {
    await renameTmuxSessions(db, map, deps.tmux ?? defaultTmuxBackendDeps.tmux, summary, failures)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  try {
    await stripRoster(deps.roster ?? defaultRoster, summary, failures)
  } catch (error) {
    failures.push(`roster: ${error instanceof Error ? error.message : String(error)}`)
  }
  await keepOrphanAttachments(deps.userData, orphans.filter((row) => row.kind === 'attachment'), summary, failures)
  await moveBrowserPartitions(deps.userData, map, summary, failures)
  try {
    summary.openWithKeysRenamed = await renameOpenWithKeys(deps.userData)
  } catch (error) {
    failures.push(`open-with defaults: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (failures.length > 0) {
    throw new Error(`task-to-session segment 2 failed (${failures.length}), will retry next start: ${failures.join('; ')}`)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SUMMARY_FILE), `${JSON.stringify({ completedAt: new Date().toISOString(), ...summary }, null, 2)}\n`, 'utf8')
  db.transaction(() => db.exec('DROP TABLE legacy_task_orphans; DROP TABLE legacy_task_map;'))()
  await writeDone(donePath, { summary: SUMMARY_FILE })
  return summary
}

const defaultRoster: NonNullable<TaskToSessionDeps['roster']> = {
  list: () => listAgents(process.env, { includeGuests: true }),
  setCache: async (agent, cache) => {
    const providerSessionId = typeof agent.cache?.provider_session_id === 'string' ? agent.cache.provider_session_id : ''
    if (agent.gugu_user_id) await updateAgent({ guguUserId: agent.gugu_user_id }, { cache })
    else if (providerSessionId) await updateAgent({ providerSessionId }, { cache })
    else throw new Error(`roster record '${agent.name}' has neither identity nor session id`)
  },
}

async function writeDone(path: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // 原子写:半截 .done 会被当成「已完成」。
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ migration: 'task → session v1', completedAt: new Date().toISOString(), ...body }, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * 迁移前整库备份(DESIGN §4.2):只在 `tasks` 表还在(= 0032 还没跑)时做,`gugu4.pre-session.db` 已经在就不覆盖
 * —— 0032 失败回滚后重启,第一份备份才是真正的迁移前状态。在线备份,WAL 里没落盘的页也在里面。
 * 在 `initializeDatabase()` 之前调。返回备份路径;不需要备份时返回 null。
 */
export async function backupBeforeTaskToSession(db: BetterSqlite3.Database, dbPath: string): Promise<string | null> {
  if (!tableExists(db, 'tasks')) return null
  const dest = join(dirname(dbPath), 'gugu4.pre-session.db')
  if (existsSync(dest)) return null
  const tmp = `${dest}.${process.pid}.tmp`
  await db.backup(tmp)
  await rename(tmp, dest)
  return dest
}
