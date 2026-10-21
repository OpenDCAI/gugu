import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '@main/db/initialize'
import { listAgents, updateAgent } from '@gugu/core/local/state/agents'
import { backupBeforeTaskToSession, DONE_FILE, ORPHAN_DIR, runTaskToSessionOnce, type TaskToSessionSummary } from './index'

/**
 * 守恒(DESIGN §4.8-1),在**真实形状**的库上读:`__fixtures__/v0251/` 是在 mac1 上用 v0.2.51 构建(61fe8fb3a4)
 * 在产品面上造出来的一份 profile(会话 / 工作区 / 附件 / 终端 / 页签 / 浏览器隔离分区 / 自动化运行 / 子会话 /
 * 活 tmux),再由 graft-v0251.py 补上产品面已经造不出来的形状(#5665 前一个 task 挂两条会话、主目录外的
 * standalone、关联 issue、悬空的自动化运行、名下没有会话的 task、侧栏手排顺序)。造法见 __fixtures__/README.md。
 *
 * 每条断言都拿迁移前从同一份库里数出来的数去比,❌ 写死期望 —— 夹具重造之后判据照样成立。
 */

const FIXTURE = fileURLToPath(new URL('./__fixtures__/v0251/', import.meta.url))
const MADE_AT = '/Users/mac1/gugu-t2s-mig-old-profile'
const HOME = '00000000-0000-4000-8000-000000000001'
const decode = (name: string) => {
  const prefix = ['gugubk-', 'gugu-'].find((p) => name.startsWith(p))!
  const [project, scope, leaf] = Buffer.from(name.slice(prefix.length), 'base64url').toString('utf8').split(':')
  return { prefix, project: project!, scope: scope!, leaf: leaf! }
}

type Before = {
  conversations: Array<{ id: string; project_id: string; task_id: string; workspace_id: string | null }>
  tasks: Array<{ id: string; project_id: string; workspace_id: string | null; type: string }>
  terminals: Array<{ id: string; task_id: string }>
  attachments: Array<{ id: string; task_id: string; stored_path: string; origin: string }>
  viewState: Array<{ key: string; value: string }>
  navigation: { currentViewId: string; viewParams: { task?: { taskId: string } } }
  sidebar: { taskOrderByProject: Record<string, string[]> }
}

describe('v0.2.51 夹具:段 1 + 段 2 之后守恒', () => {
  let dir = ''
  let userData = ''
  let db: Database.Database
  let before: Before
  let scopeOwner: Map<string, string>
  let tmuxNames: Set<string>
  let summary: TaskToSessionSummary
  let backup: string | null

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-t2s-v0251-'))
    userData = path.join(dir, 'user-data')
    fs.cpSync(FIXTURE, userData, { recursive: true })
    const dbPath = path.join(userData, 'gugu4.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    // 附件行存的是造夹具那台机器上的绝对路径:换成这份副本的位置(= 同一台机器上原地升级)。
    db.prepare('UPDATE task_attachments SET stored_path = replace(stored_path, ?, ?)').run(MADE_AT, userData)
    before = {
      conversations: db.prepare('SELECT c.id, c.project_id, c.task_id, t.workspace_id FROM conversations c JOIN tasks t ON t.id = c.task_id').all() as Before['conversations'],
      tasks: db.prepare('SELECT id, project_id, workspace_id, type FROM tasks').all() as Before['tasks'],
      terminals: db.prepare('SELECT id, task_id FROM terminals').all() as Before['terminals'],
      attachments: db.prepare('SELECT id, task_id, stored_path, origin FROM task_attachments').all() as Before['attachments'],
      viewState: db.prepare(`SELECT key, value FROM kv WHERE key LIKE 'view-state:task:%'`).all() as Before['viewState'],
      navigation: JSON.parse((db.prepare(`SELECT value FROM kv WHERE key = 'view-state:navigation'`).get() as { value: string }).value),
      sidebar: JSON.parse((db.prepare(`SELECT value FROM kv WHERE key = 'view-state:sidebar'`).get() as { value: string }).value),
    }
    // 代表会话:首条,否则最近交互的那条(与 0032 同一个规则,这里从迁移前的库独立算一遍)。
    scopeOwner = new Map(
      (db.prepare(`SELECT task_id, id FROM (SELECT task_id, id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY
        coalesce(is_initial_conversation, 0) DESC, coalesce(last_interacted_at, updated_at, created_at) DESC, id) AS r
        FROM conversations) WHERE r = 1`).all() as Array<{ task_id: string; id: string }>).map((r) => [r.task_id, r.id])
    )
    tmuxNames = new Set(fs.readFileSync(path.join(userData, 'tmux-sessions.txt'), 'utf8').split('\n').filter(Boolean))

    backup = await backupBeforeTaskToSession(db, dbPath)
    await initializeDatabase(db)
    const env = { ...process.env, GUGU_HOME: path.join(userData, 'gugu-home') }
    const live = tmuxNames
    summary = (await runTaskToSessionOnce({
      db,
      userData,
      tmux: async (args) => {
        if (args[0] === 'list-sessions') return [...live].join('\n')
        for (let i = 0; i < args.length; i += 5) {
          const [, , target, to] = args.slice(i, i + 4)
          live.delete(target!.slice(1))
          live.add(to!)
        }
        return ''
      },
      roster: {
        list: () => listAgents(env, { includeGuests: true }),
        setCache: async (agent, cache) => void (await updateAgent({ guguUserId: agent.gugu_user_id }, { cache }, env)),
      },
    }))!
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const orphanTaskIds = () => new Set(before.tasks.filter((t) => !scopeOwner.has(t.id)).map((t) => t.id))

  it('阳控:夹具里每一种形状都在(否则下面的守恒是在空集上成立)', () => {
    const perTask = new Map<string, number>()
    for (const c of before.conversations) perTask.set(c.task_id, (perTask.get(c.task_id) ?? 0) + 1)
    expect([...perTask.values()].some((n) => n > 1)).toBe(true)
    expect(orphanTaskIds().size).toBeGreaterThan(0)
    expect(before.tasks.some((t) => t.type === 'standalone' && t.project_id !== HOME)).toBe(true)
    expect(before.tasks.some((t) => t.type === 'automation-run')).toBe(true)
    expect(before.attachments.some((a) => !orphanTaskIds().has(a.task_id))).toBe(true)
    expect(before.terminals.some((x) => !orphanTaskIds().has(x.task_id))).toBe(true)
    expect(before.viewState.some((v) => v.value.includes('"kind":"browser"'))).toBe(true)
    expect(before.navigation.currentViewId).toBe('task')
    expect([...tmuxNames].some((n) => n.startsWith('gugubk-'))).toBe(true)
    expect(backup).not.toBeNull()
    const openWith = Object.keys(JSON.parse(fs.readFileSync(path.join(FIXTURE, 'task-extensions/.open-with-defaults.json'), 'utf8')))
    expect(openWith.some((k) => k.startsWith('task:'))).toBe(true)
    expect(openWith.some((k) => k.startsWith('group:'))).toBe(true)
  })

  it('会话数不变,每条会话都有工作区,而且是它原来那个 task 的工作区', () => {
    const after = db.prepare('SELECT id, workspace_id FROM sessions').all() as Array<{ id: string; workspace_id: string | null }>
    expect(after.map((c) => c.id).sort()).toEqual(before.conversations.map((c) => c.id).sort())
    const want = new Map(before.conversations.map((c) => [c.id, c.workspace_id]))
    for (const c of after) {
      expect(c.workspace_id).not.toBeNull()
      expect(c.workspace_id).toBe(want.get(c.id))
    }
  })

  it('附件都能打开:有会话的那些归给代表会话、路径不变;无主的自有文件挪进迁移目录,内容不变', () => {
    const rows = db.prepare('SELECT id, session_id, stored_path FROM session_attachments').all() as Array<{ id: string; session_id: string; stored_path: string }>
    const owned = before.attachments.filter((a) => !orphanTaskIds().has(a.task_id))
    expect(rows.map((r) => r.id).sort()).toEqual(owned.map((a) => a.id).sort())
    for (const row of rows) {
      const was = owned.find((a) => a.id === row.id)!
      expect(row.session_id).toBe(scopeOwner.get(was.task_id))
      expect(row.stored_path).toBe(was.stored_path)
      expect(fs.readFileSync(row.stored_path).length).toBeGreaterThan(0)
    }
    const orphans = before.attachments.filter((a) => orphanTaskIds().has(a.task_id))
    expect(summary.orphans.attachments.map((a) => a.id).sort()).toEqual(orphans.map((a) => a.id).sort())
    for (const entry of summary.orphans.attachments) {
      if (entry.origin !== 'copy') { expect(entry.movedTo).toBeNull(); continue }
      expect(entry.movedTo!.startsWith(path.join(userData, 'migrations', ORPHAN_DIR))).toBe(true)
      expect(fs.existsSync(entry.storedPath)).toBe(false)
      expect(fs.readFileSync(entry.movedTo!, 'utf8')).toContain('orphan attachment bytes')
    }
  })

  it('终端都有归属(代表会话);无主 task 的终端计数进摘要', () => {
    const rows = db.prepare('SELECT x.id, x.session_id, c.id AS live FROM terminals x LEFT JOIN sessions c ON c.id = x.session_id').all() as Array<{ id: string; session_id: string; live: string | null }>
    for (const row of rows) expect(row.live).toBe(row.session_id)
    const kept = before.terminals.filter((x) => !orphanTaskIds().has(x.task_id))
    expect(rows.map((r) => [r.id, r.session_id]).sort()).toEqual(kept.map((x) => [x.id, scopeOwner.get(x.task_id)]).sort())
    expect(summary.orphans.terminals.sort()).toEqual(before.terminals.filter((x) => orphanTaskIds().has(x.task_id)).map((x) => x.id).sort())
  })

  it('页签能恢复:按 task 记的视图状态换到代表会话,值只换了 task id;无主 task 的计数进摘要', () => {
    for (const { key, value } of before.viewState) {
      const [, , taskId, tabs] = key.split(':')
      const sid = scopeOwner.get(taskId!)
      if (!sid) continue
      const now = db.prepare('SELECT value FROM kv WHERE key = ?').get(`view-state:session:${sid}${tabs ? ':tabs' : ''}`) as { value: string } | undefined
      expect(now?.value).toBe(value.split(`"taskId":"${taskId}"`).join(`"sessionId":"${sid}"`))
    }
    expect(db.prepare(`SELECT count(*) AS n FROM kv WHERE key LIKE 'view-state:task:%'`).get()).toEqual({ n: 0 })
    expect(summary.orphans.kv.sort()).toEqual(before.viewState.filter((v) => !scopeOwner.has(v.key.split(':')[2]!)).map((v) => v.key).sort())
  })

  it('浏览器隔离分区:新代码按快照身份现算出来的分区名,正好是段 2 改名后的目录,cookie 还是原来那份', () => {
    let checked = 0
    for (const { value } of db.prepare(`SELECT value FROM kv WHERE key LIKE 'view-state:session:%:tabs'`).all() as Array<{ value: string }>) {
      for (const group of JSON.parse(value).groups) {
        for (const tab of group.tabManager.tabs) {
          if (tab.kind !== 'browser' || tab.session.profileId !== 'isolated-per-task') continue
          const { projectId, workspaceId, sessionId } = tab.session
          const dirName = `gugu-browser-isolated-${projectId}-${workspaceId}-${sessionId}`
          expect(fs.readFileSync(path.join(userData, 'Partitions', dirName, 'Cookies'), 'utf8')).toContain(tab.session.partition.slice('persist:'.length).trim())
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(summary.browserPartitions.orphaned.length).toBe(
      fs.readdirSync(path.join(FIXTURE, 'Partitions')).filter((d) => orphanTaskIds().has(d.slice(-36))).length
    )
  })

  it('上次停的视图与侧栏手排顺序换成会话 id', () => {
    const nav = JSON.parse((db.prepare(`SELECT value FROM kv WHERE key = 'view-state:navigation'`).get() as { value: string }).value)
    const taskId = before.navigation.viewParams.task!.taskId
    expect(nav.currentViewId).toBe(scopeOwner.has(taskId) ? 'session' : 'home')
    if (scopeOwner.has(taskId)) expect(nav.viewParams.session.sessionId).toBe(scopeOwner.get(taskId))
    expect(JSON.stringify(nav)).not.toContain('taskId')
    const sidebar = JSON.parse((db.prepare(`SELECT value FROM kv WHERE key = 'view-state:sidebar'`).get() as { value: string }).value)
    for (const [project, taskIds] of Object.entries(before.sidebar.taskOrderByProject)) {
      const expected = taskIds.flatMap((t) => {
        const sessions = before.conversations.filter((c) => c.task_id === t).map((c) => c.id)
        const owner = scopeOwner.get(t)
        return owner ? [owner, ...sessions.filter((s) => s !== owner).sort()] : []
      })
      expect(sidebar.sessionOrderByProject[project]).toEqual(expected)
    }
  })

  it('活 tmux:每个都改到新 pty id(会话终端 = <项目>:<会话>:<会话>,普通终端 = <项目>:<会话>:<终端>),成对的仍成对', () => {
    const sessions = new Set(before.conversations.map((c) => c.id))
    const terminals = new Map((db.prepare('SELECT id, session_id FROM terminals').all() as Array<{ id: string; session_id: string }>).map((t) => [t.id, t.session_id]))
    expect(summary.tmux.renamed.length).toBe(tmuxNames.size)
    for (const name of tmuxNames) {
      const { project, scope, leaf } = decode(name)
      expect(sessions.has(scope)).toBe(true)
      expect(leaf === scope || terminals.get(leaf) === scope).toBe(true)
      expect(before.conversations.find((c) => c.id === scope)!.project_id).toBe(project)
    }
    for (const name of tmuxNames) if (name.startsWith('gugubk-')) expect(tmuxNames.has(`gugu-${name.slice('gugubk-'.length)}`)).toBe(true)
    expect(summary.tmux.unrecognized).toEqual([])
  })

  it('名册与生命周期状态:旧键删掉,别的键一个不少', () => {
    const before = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'gugu-home/agents.json'), 'utf8')).agents
    const after = JSON.parse(fs.readFileSync(path.join(userData, 'gugu-home/agents.json'), 'utf8')).agents
    expect(after.map((a: { cache: Record<string, unknown> }) => a.cache)).toEqual(
      before.map((a: { cache: Record<string, unknown> }) => { const { emdash_task_id: _, ...rest } = a.cache; return rest })
    )
    expect(summary.roster.stripped).toBe(before.filter((a: { cache: object }) => 'emdash_task_id' in a.cache).length)
  })

  it('App「始终用它」:task:<认领> 换成 session:<认领>,值一字不动;group: 原样;改了几条进摘要', () => {
    const was = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'task-extensions/.open-with-defaults.json'), 'utf8')) as Record<string, string>
    const now = JSON.parse(fs.readFileSync(path.join(userData, 'task-extensions/.open-with-defaults.json'), 'utf8')) as Record<string, string>
    expect(now).toEqual(Object.fromEntries(Object.entries(was).map(([key, tab]) => [key.startsWith('task:') ? `session:${key.slice('task:'.length)}` : key, tab])))
    expect(summary.openWithKeysRenamed).toBe(Object.keys(was).filter((key) => key.startsWith('task:')).length)
  })

  it('摘要的 standalone 核对与 task 计数;库里不再有 task 和交接表,.done 已写;备份是迁移前那份', () => {
    expect(summary.sessions).toBe(before.conversations.length)
    expect(summary.tasks.total).toBe(before.tasks.length)
    expect(summary.standaloneMismatch.standaloneOutsideHome.sort()).toEqual(
      before.tasks.filter((t) => t.type === 'standalone' && t.project_id !== HOME).map((t) => t.id).sort()
    )
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('tasks', 'task_attachments', 'legacy_task_map', 'legacy_task_orphans')`).all()).toEqual([])
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
    const copy = new Database(backup!, { readonly: true })
    expect(copy.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: before.tasks.length })
    copy.close()
  })
})
