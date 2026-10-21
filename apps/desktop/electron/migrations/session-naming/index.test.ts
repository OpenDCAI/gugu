import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '@main/db/initialize'
import type { LocalAgentRecord } from '@gugu/core/local/state/agents'
import { backupBeforeSessionNaming, DONE_FILE, PREVIOUS_BACKUP_FILE, runSessionNamingOnce, SUMMARY_FILE } from './index'

/**
 * 名字层段 2:库里存着的 JSON 与库外文件里的旧键名、旧值改成新的。种子按 0033 之前的版本写下的形状写进
 * 跑完全部迁移(含 0033)的库,再跑段 2,逐处读回。
 */

const json = (value: unknown) => JSON.stringify(value)

function fakeRoster(agents: LocalAgentRecord[], options: { fail?: boolean } = {}) {
  return {
    agents,
    list: async () => agents.map((agent) => ({ ...agent, cache: agent.cache ? { ...agent.cache } : agent.cache })),
    setCache: async (agent: LocalAgentRecord, cache: Record<string, unknown>) => {
      if (options.fail) throw new Error('roster locked')
      agents.find((a) => a.gugu_user_id === agent.gugu_user_id)!.cache = cache
    },
  }
}

const agent = (id: string, cache: Record<string, unknown>): LocalAgentRecord => ({
  name: id, agent_type: 'claude' as LocalAgentRecord['agent_type'], path: '/x', gugu_user_id: id, prompt: '', created_at: 0, cache,
})

const tabs = {
  activeGroupId: 'g',
  groups: [{
    groupId: 'g',
    tabManager: {
      activeTabId: 't1',
      tabs: [
        { kind: 'conversation', tabId: 't1', conversationId: 's1', isPreview: false },
        { kind: 'acp-chat', tabId: 't2', conversationId: 's1', isPreview: false },
        { kind: 'review', tabId: 't3', conversationId: 's1', isPreview: false },
        { kind: 'browser', tabId: 't4', isPreview: false, browserId: 'b', session: { profileId: 'isolated-per-task', partition: 'persist:gugu-browser-isolated-p-w-s1' } },
        { kind: 'browser', tabId: 't5', isPreview: false, browserId: 'c', session: { profileId: 'work', partition: 'persist:gugu-browser-profile-work' } },
        { kind: 'file', tabId: 't6', path: 'a.ts', isPreview: false },
      ],
    },
  }],
}

function seedDatabase(db: Database.Database) {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p1', 'P', '/repo')
  const kv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
  kv.run('view-state:sidebar', json({ projectOrder: ['p1'], expandedConversationIds: ['s1'], taskSortBy: 'updated-at', tasksCollapsed: true }))
  kv.run('view-state:navigation', json({ currentViewId: 'new-task', viewParams: { 'new-task': { projectId: 'p1' }, session: { projectId: 'p1', sessionId: 's1' } } }))
  kv.run('view-state:project:p1', json({ activeView: 'sessions', taskViewTab: 'archived' }))
  kv.run('view-state:session:s1:tabs', json(tabs))
  kv.run('view-state:session:s2', json({
    focusedRegion: 'main',
    tabManager: { activeTabId: 't', tabs: [{ kind: 'conversation', tabId: 't', conversationId: 's2', isPreview: true }] },
    conversations: { tabOrder: ['s2'], activeTabId: 's2' },
  }))
  kv.run('view-state:session:s3', 'not json')
  kv.run('sessionpage-platform-model:s1', json({ modelId: 'm' }))
  const setting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
  // taskNext 自定义、sessionNext 没有 → 搬;taskPrev 只是解绑 → 丢;pinTask 与 pinConversation 都自定义 → 后者改名成 pinSession,以它为准;
  // deleteConversation(⌃X 两次)改绑过 → 跟到归档那一个(#6949)
  setting.run('keyboard', json({ newTask: 'Mod+J', taskNext: 'Mod+K', taskPrev: null, pinTask: 'Mod+P', pinConversation: 'Mod+Shift+P', deleteConversation: 'Control+D', tabNext: 'Mod+]' }))
  setting.run('browser', json({ defaultProfileId: 'isolated-per-task', relaxCorsForLocalhost: false, profiles: [{ id: 'default', name: 'Default' }] }))
  setting.run('sessions', json({ autoGenerateName: false }))
  db.prepare('INSERT INTO project_settings (project_id, base_project_settings_json) VALUES (?, ?)')
    .run('p1', json({ autoRunSetupScriptOnTaskCreation: false, autoRunRunScriptOnTaskCreation: true, worktreeDirectory: '/w' }))
  const session = db.prepare('INSERT INTO sessions (id, project_id, title, config) VALUES (?, ?, ?, ?)')
  session.run('s1', 'p1', 'One', json({ version: '1', type: 'pty', forkedFrom: { conversationId: 's0', title: 'Zero' }, startupOrigin: 'task-page' }))
  session.run('s2', 'p1', 'Two', null)
  session.run('s3', 'p1', 'Three', json({ version: '1', type: 'acp', startupOrigin: 'chat-page' }))
  const stored = json({
    version: '1',
    taskConfig: { version: '1', name: 'daily', initialConversation: { id: 'x', provider: 'claude', startupOrigin: 'task-page' } },
    workspaceConfig: { version: '2', workspace: { kind: 'repository-instance', workspaceId: 'w' } },
  })
  db.prepare(`INSERT INTO automations (id, name, project_id, agent_config, session_config, trigger_config, created_at, updated_at)
    VALUES ('a1', 'A', 'p1', '{"prompt":"go"}', ?, '{}', 1, 1)`).run(stored)
  db.prepare(`INSERT INTO automation_runs (id, automation_id, status, trigger_kind, session_config_snapshot) VALUES ('r1', 'a1', 'done', 'cron', ?)`).run(stored)
}

function seedFiles(root: string) {
  const guguHome = path.join(root, 'gugu-home')
  const userData = path.join(root, 'user-data')
  const claudeProjects = path.join(root, 'claude', 'projects')
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : json(value))
  }
  write(path.join(guguHome, 'platform-access', 'acc-1.json'), { sessionId: 'acc-1', ownerUserId: 'u', pid: 1, processStartedAt: 'x', issuedAt: 'y', conversationId: 's1' })
  // 已经是新形状:sessionId 是会话 id,❌ 再改成票 id
  write(path.join(guguHome, 'platform-access', 'acc-2.json'), { accessSessionId: 'acc-2', ownerUserId: 'u', pid: 1, processStartedAt: 'x', issuedAt: 'y', sessionId: 's2' })
  write(path.join(guguHome, 'runtime-fork-ownership', 'view-a.json'), {
    version: 1, kind: 'runtime-only-fork', runtimeSessionId: 'view-a', sourceConversationId: 's1', forkedFromConversationId: 's1',
    provider: 'claude', providerSessionId: 'prov', workspaceId: 'w', cwd: '/repo', status: 'active', updatedAt: 'z',
  })
  write(path.join(userData, 'hook-sources.json'), { records: [{ key: 'tok', id: 'i', ptyId: 'p', harnessVersion: null, sessionId: 'pty-1' }] })
  write(path.join(claudeProjects, '-repo', '.gugu-continuations', 's1.json'), {
    version: 1, kind: 'provider-continuation', conversationId: 's1', sourceSessionId: 'src', startedAt: '2026-10-05T00:00:00.000Z', continuationSessionId: 'cont',
  })
  write(path.join(claudeProjects, '-repo', '.gugu-continuations', 'broken.json'), '{')
  fs.mkdirSync(path.join(claudeProjects, '-other'), { recursive: true })
  return { guguHome, userData, claudeProjects }
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('名字层段 2', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  async function setup(options: { failRoster?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-naming-'))
    const db = new Database(path.join(root, 'gugu.db'))
    cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
    await initializeDatabase(db)
    seedDatabase(db)
    const dirs = seedFiles(root)
    const roster = fakeRoster([
      agent('agent-1', { emdash_conversation_id: 's1', taskpage_group_chat_id: 'g', taskpage_session_surface: 'task-tui', taskpage_owner_user_id: 'u', provider_session_id: 'prov' }),
      agent('agent-2', { taskpage_parked_conversation_id: 's2', taskpage_session_surface: 'task-acp', taskpage_cloud_identity_state: 'ok' }),
      agent('agent-3', { provider_session_id: 'other' }),
    ], { fail: options.failRoster })
    const run = (roster_ = roster) => runSessionNamingOnce({ db, userData: dirs.userData, guguHome: dirs.guguHome, claudeProjectsDir: dirs.claudeProjects, roster: roster_ })
    return { db, root, ...dirs, roster, run }
  }

  const kv = (db: Database.Database, key: string) => JSON.parse((db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string }).value)
  const setting = (db: Database.Database, key: string) => JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string }).value)

  it('库里的 JSON:视图状态、快捷键(含三对合并)、浏览器档案、项目设置、会话配置、自动化,逐处换成新名字', async () => {
    const { db, run } = await setup()
    const summary = await run()

    expect(kv(db, 'view-state:sidebar')).toEqual({ projectOrder: ['p1'], expandedSessionIds: ['s1'], sessionSortBy: 'updated-at', sessionsCollapsed: true })
    expect(kv(db, 'view-state:navigation')).toEqual({ currentViewId: 'new-session', viewParams: { 'new-session': { projectId: 'p1' }, session: { projectId: 'p1', sessionId: 's1' } } })
    expect(kv(db, 'view-state:project:p1')).toEqual({ activeView: 'sessions', sessionViewTab: 'archived' })
    expect(kv(db, 'view-state:session:s1:tabs').groups[0].tabManager.tabs).toEqual([
      { kind: 'session', tabId: 't1', sessionId: 's1', isPreview: false },
      { kind: 'acp-chat', tabId: 't2', sessionId: 's1', isPreview: false },
      { kind: 'review', tabId: 't3', sessionId: 's1', isPreview: false },
      { kind: 'browser', tabId: 't4', isPreview: false, browserId: 'b', session: { profileId: 'isolated-per-session', partition: 'persist:gugu-browser-isolated-p-w-s1' } },
      { kind: 'browser', tabId: 't5', isPreview: false, browserId: 'c', session: { profileId: 'work', partition: 'persist:gugu-browser-profile-work' } },
      { kind: 'file', tabId: 't6', path: 'a.ts', isPreview: false },
    ])
    // 旧的整份视图状态:单格 tabManager 里的 tab 一样改;最老那份 `conversations` 是读旧名字用的成员,不动
    expect(kv(db, 'view-state:session:s2')).toEqual({
      focusedRegion: 'main',
      tabManager: { activeTabId: 't', tabs: [{ kind: 'session', tabId: 't', sessionId: 's2', isPreview: true }] },
      conversations: { tabOrder: ['s2'], activeTabId: 's2' },
    })
    expect((db.prepare(`SELECT value FROM kv WHERE key = 'view-state:session:s3'`).get() as { value: string }).value).toBe('not json')

    expect(setting(db, 'keyboard')).toEqual({ newSession: 'Mod+J', sessionNext: 'Mod+K', pinSession: 'Mod+Shift+P', archiveHighlightedSession: 'Control+D', tabNext: 'Mod+]' })
    expect(summary!.db.keyboard).toEqual({
      renamed: 3,
      merged: [{ from: 'taskNext', to: 'sessionNext' }],
      dropped: [
        { from: 'taskPrev', to: 'sessionPrev', reason: 'unbound' },
        { from: 'pinTask', to: 'pinSession', reason: 'survivor-customized' },
      ],
    })
    expect(setting(db, 'browser').defaultProfileId).toBe('isolated-per-session')
    expect(setting(db, 'sessions')).toEqual({ autoGenerateName: false })

    expect(JSON.parse((db.prepare(`SELECT base_project_settings_json AS v FROM project_settings`).get() as { v: string }).v))
      .toEqual({ autoRunSetupScriptOnSessionCreation: false, autoRunRunScriptOnSessionCreation: true, worktreeDirectory: '/w' })

    const configs = db.prepare(`SELECT id, config FROM sessions ORDER BY id`).all() as Array<{ id: string; config: string | null }>
    expect(configs.map((row) => [row.id, row.config && JSON.parse(row.config)])).toEqual([
      ['s1', { version: '1', type: 'pty', forkedFrom: { sessionId: 's0', title: 'Zero' }, startupOrigin: 'session-page' }],
      ['s2', null],
      ['s3', { version: '1', type: 'acp', startupOrigin: 'chat-page' }],
    ])

    const expected = {
      version: '1',
      sessionConfig: { version: '1', name: 'daily', initialSession: { id: 'x', provider: 'claude', startupOrigin: 'session-page' } },
      workspaceConfig: { version: '2', workspace: { kind: 'repository-instance', workspaceId: 'w' } },
    }
    expect(JSON.parse((db.prepare(`SELECT session_config AS v FROM automations`).get() as { v: string }).v)).toEqual(expected)
    expect(JSON.parse((db.prepare(`SELECT session_config_snapshot AS v FROM automation_runs`).get() as { v: string }).v)).toEqual(expected)
    expect(db.prepare(`SELECT agent_config FROM automations`).get()).toEqual({ agent_config: '{"prompt":"go"}' })

    expect(summary!.db).toMatchObject({
      viewState: 5, browserDefaultProfile: 1, projectSettings: 1, sessionConfigs: 1, automations: 1, automationRuns: 1,
      unreadable: ['kv:view-state:session:s3'],
    })
  })

  it('库外的文件:名册键与 surface 值、钩子凭据、平台票账本、续接意图、分叉归属;新形状的账本不碰', async () => {
    const { run, roster, guguHome, userData, claudeProjects } = await setup()
    const summary = await run()

    expect(roster.agents.map((a) => a.cache)).toEqual([
      { emdash_session_id: 's1', sessionpage_group_chat_id: 'g', sessionpage_session_surface: 'tui', sessionpage_owner_user_id: 'u', provider_session_id: 'prov' },
      { sessionpage_parked_session_id: 's2', sessionpage_session_surface: 'acp', sessionpage_cloud_identity_state: 'ok' },
      { provider_session_id: 'other' },
    ])
    expect(readJson(path.join(userData, 'hook-sources.json'))).toEqual({ records: [{ key: 'tok', id: 'i', ptyId: 'p', harnessVersion: null, ptySessionId: 'pty-1' }] })
    expect(readJson(path.join(guguHome, 'platform-access', 'acc-1.json'))).toEqual({ accessSessionId: 'acc-1', ownerUserId: 'u', pid: 1, processStartedAt: 'x', issuedAt: 'y', sessionId: 's1' })
    expect(readJson(path.join(guguHome, 'platform-access', 'acc-2.json'))).toEqual({ accessSessionId: 'acc-2', ownerUserId: 'u', pid: 1, processStartedAt: 'x', issuedAt: 'y', sessionId: 's2' })
    expect(readJson(path.join(claudeProjects, '-repo', '.gugu-continuations', 's1.json'))).toEqual({
      version: 1, kind: 'provider-continuation', sessionId: 's1', sourceProviderSessionId: 'src', startedAt: '2026-10-05T00:00:00.000Z', continuationProviderSessionId: 'cont',
    })
    expect(readJson(path.join(guguHome, 'runtime-fork-ownership', 'view-a.json'))).toMatchObject({ sourceSessionId: 's1', forkedFromSessionId: 's1' })
    expect(readJson(path.join(guguHome, 'runtime-fork-ownership', 'view-a.json'))).not.toHaveProperty('sourceConversationId')
    expect(summary!.files).toEqual({
      roster: 2, hookSources: 1, accessLedger: 1, continuations: 1, forkOwnership: 1,
      unreadable: [path.join(claudeProjects, '-repo', '.gugu-continuations', 'broken.json')],
    })
  })

  it('写 .done 与摘要;.done 在就不再跑;.done 丢了重跑一遍什么都不改(账本的会话 id 不会被当成票 id)', async () => {
    const { run, userData, guguHome, db } = await setup()
    await run()
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
    expect(readJson(path.join(userData, 'migrations', SUMMARY_FILE)).db.keyboard.merged).toEqual([{ from: 'taskNext', to: 'sessionNext' }])
    expect(await run()).toBeNull()

    const before = db.prepare('SELECT key, value FROM kv ORDER BY key').all()
    fs.rmSync(path.join(userData, 'migrations', DONE_FILE))
    const again = await run()
    expect(again!.db).toMatchObject({ viewState: 0, keyboard: { renamed: 0, merged: [], dropped: [] }, sessionConfigs: 0, automations: 0 })
    expect(again!.files).toMatchObject({ roster: 0, hookSources: 0, accessLedger: 0, continuations: 0, forkOwnership: 0 })
    expect(db.prepare('SELECT key, value FROM kv ORDER BY key').all()).toEqual(before)
    expect(readJson(path.join(guguHome, 'platform-access', 'acc-1.json'))).toMatchObject({ accessSessionId: 'acc-1', sessionId: 's1' })
  })

  it('一项失败:别的照做,响亮上抛,不写 .done;下次启动接着做完', async () => {
    const { run, userData, db, roster } = await setup({ failRoster: true })
    await expect(run()).rejects.toThrow(/session-naming segment 2 failed \(1\).*roster: roster locked/)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(false)
    expect(kv(db, 'view-state:sidebar')).toHaveProperty('sessionsCollapsed', true)

    const summary = await run(fakeRoster(roster.agents))
    expect(summary!.files.roster).toBe(2)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
  })
})

describe('0033 之前的整库备份', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  function open(tables: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-naming-backup-'))
    const file = path.join(dir, `gugu4-${crypto.randomUUID()}.db`)
    const db = new Database(file)
    db.pragma('journal_mode = WAL') // 跟真库一样
    for (const table of tables) db.exec(`CREATE TABLE ${table} (id TEXT)`)
    // 上一次迁移(task → session)留下的那份
    const previous = path.join(dir, PREVIOUS_BACKUP_FILE)
    fs.writeFileSync(previous, 'previous backup')
    cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
    return { db, file, previous, dest: path.join(dir, 'gugu4.pre-session-naming.db') }
  }

  it('conversations 还在 = 0033 没跑:备一份,核过之后删掉上一次迁移那份(同一时刻只留一份);已经在就不覆盖', async () => {
    const { db, file, dest, previous } = open(['conversations'])
    expect(await backupBeforeSessionNaming(db, file)).toBe(dest)
    // 核对副本的连接不留下 `<tmp>-shm` / `<tmp>-wal`
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))).toEqual([])
    const copy = new Database(dest, { readonly: true })
    expect(copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([{ name: 'conversations' }])
    copy.close()
    expect(fs.existsSync(previous)).toBe(false)
    const first = fs.statSync(dest).mtimeMs
    expect(await backupBeforeSessionNaming(db, file)).toBeNull()
    expect(fs.statSync(dest).mtimeMs).toBe(first)
  })

  it('tasks 也在 = 连 0032 一起跑,task-to-session 那份就是迁移前的状态;sessions 已经在 = 跑过了:都不备,上一份照留', async () => {
    const both = open(['tasks', 'conversations'])
    expect(await backupBeforeSessionNaming(both.db, both.file)).toBeNull()
    const done = open(['sessions'])
    expect(await backupBeforeSessionNaming(done.db, done.file)).toBeNull()
    expect(fs.existsSync(both.dest) || fs.existsSync(done.dest)).toBe(false)
    expect(fs.existsSync(both.previous) && fs.existsSync(done.previous)).toBe(true)
  })
})
