import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '@main/db/initialize'
import type { LocalAgentRecord } from '@gugu/core/local/state/agents'
import { backupBeforeTaskToSession, DONE_FILE, ORPHAN_DIR, runTaskToSessionOnce, SUMMARY_FILE } from './index'
import { openAt0031 } from './test-support'

/**
 * 段 2:读 0032 留下的两张交接表,做库外的事(tmux 改名、名册、无主附件),然后 DROP 交接表、写 .done。
 * 判据都在**库跑过 0032 之后**读:先在停在 0031 的库上种 v0.2.51 形状,再走产品自己的 initializeDatabase。
 */

const HOME = '00000000-0000-4000-8000-000000000001'
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const tui = (id: string) => `gugu-${b64(id)}`
const bk = (id: string) => `gugubk-${b64(id)}`

/** 只认段 2 会发的两种命令:list-sessions 与用 `;` 串起来的一串 rename-session -t =<旧> <新>。 */
function fakeTmux(initial: string[], options: { failRename?: string } = {}) {
  const names = new Set(initial)
  const calls: string[][] = []
  const tmux = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-sessions') {
      if (names.size === 0) throw Object.assign(new Error('exit 1'), { stderr: 'no server running on /tmp/tmux-501/x' })
      return [...names].join('\n') + '\n'
    }
    const commands: string[][] = [[]]
    for (const arg of args) arg === ';' ? commands.push([]) : commands[commands.length - 1]!.push(arg)
    for (const [verb, flag, target, to] of commands) {
      if (verb !== 'rename-session' || flag !== '-t' || !target?.startsWith('=') || !to) throw new Error(`unexpected tmux ${args.join(' ')}`)
      if (options.failRename && target.slice(1) === options.failRename) throw new Error('tmux: rename refused')
    }
    for (const [, , target, to] of commands) {
      if (!names.delete(target!.slice(1))) throw new Error(`can't find session: ${target}`)
      names.add(to!)
    }
    return ''
  }
  return { tmux, names, calls }
}

function fakeRoster(agents: LocalAgentRecord[]) {
  return {
    agents,
    list: async () => agents.map((agent) => ({ ...agent, cache: agent.cache ? { ...agent.cache } : agent.cache })),
    setCache: async (agent: LocalAgentRecord, cache: Record<string, unknown>) => {
      agents.find((a) => a.gugu_user_id === agent.gugu_user_id)!.cache = cache
    },
  }
}

const agent = (id: string, cache: Record<string, unknown>): LocalAgentRecord => ({
  name: id, agent_type: 'claude' as LocalAgentRecord['agent_type'], path: '/x', gugu_user_id: id, prompt: '', created_at: 0, cache,
})

// T-multi:#5665 前两条会话 + 一个终端;T-solo:standalone 却不在主目录项目;T-home:在主目录项目却不是 standalone;
// T-empty:名下没有会话,带一个终端、一个自有附件(盘上有文件)、一个引用附件、两条视图状态。
function seed(db: Database.Database, userData: string) {
  const ownedFile = path.join(userData, 'task-attachments', 'T-empty', 'owned.txt')
  fs.mkdirSync(path.dirname(ownedFile), { recursive: true })
  fs.writeFileSync(ownedFile, 'orphan bytes')
  db.exec(`
    INSERT INTO projects (id, name, path) VALUES ('P', 'p', '/p'), ('${HOME}', 'home', '/home');
    INSERT INTO tasks (id, project_id, name, status, workspace_id, type) VALUES
      ('T-multi', 'P', 'multi', 'todo', 'W', 'task'),
      ('T-solo', 'P', 'solo', 'todo', 'W', 'standalone'),
      ('T-home', '${HOME}', 'home', 'todo', 'W', 'task'),
      ('T-empty', 'P', 'empty', 'todo', NULL, 'task');
    INSERT INTO conversations (id, project_id, task_id, title, is_initial_conversation) VALUES
      ('C-first', 'P', 'T-multi', 'first', 1), ('C-second', 'P', 'T-multi', 'second', 0),
      ('C-solo', 'P', 'T-solo', 'solo', 1), ('C-home', '${HOME}', 'T-home', 'home', 1);
    INSERT INTO terminals (id, project_id, task_id, name) VALUES ('X-multi', 'P', 'T-multi', 'sh'), ('X-empty', 'P', 'T-empty', 'sh');
    INSERT INTO task_attachments (id, task_id, name, size, stored_path, origin) VALUES
      ('F-owned', 'T-empty', 'owned.txt', 12, '${ownedFile}', 'copy'),
      ('F-ref', 'T-empty', 'ref.txt', 1, '/Users/someone/ref.txt', 'reference');
    INSERT INTO kv (key, value) VALUES ('view-state:task:T-empty', '{}'), ('view-state:task:T-empty:tabs', '{}'),
      ('view-state:task:T-deleted-long-ago:tabs', '{}');
  `)
  return { ownedFile }
}

const LIVE = {
  multiFirst: 'P:T-multi:C-first',
  multiSecond: 'P:T-multi:C-second',
  multiTerminal: 'P:T-multi:X-multi',
  solo: 'P:T-solo:C-solo',
  emptyTerminal: 'P:T-empty:X-empty',
  lifecycle: 'P:W:lifecycle-1',
}
const liveNames = () => [
  tui(LIVE.multiFirst), bk(LIVE.multiFirst),
  `emdash-${b64(LIVE.multiSecond)}`,
  tui(LIVE.multiTerminal),
  tui(LIVE.solo), bk(LIVE.solo),
  tui(LIVE.emptyTerminal),
  tui(LIVE.lifecycle),
  'user-own-session',
]

describe('task → session 段 2', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  async function migrated() {
    const handle = openAt0031()
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-t2s-'))
    cleanups.push(() => { handle.close(); fs.rmSync(userData, { recursive: true, force: true }) })
    const seeded = seed(handle.sqlite, userData)
    await initializeDatabase(handle.sqlite)
    return { db: handle.sqlite, userData, ...seeded }
  }

  it('阳控:0032 之后、段 2 之前,两张交接表都在,无主 task 的三类行都记进了 legacy_task_orphans', async () => {
    const { db } = await migrated()
    expect(db.prepare('SELECT kind, ref FROM legacy_task_orphans ORDER BY kind, ref').all()).toEqual([
      { kind: 'attachment', ref: 'F-owned' },
      { kind: 'attachment', ref: 'F-ref' },
      { kind: 'kv', ref: 'view-state:task:T-deleted-long-ago:tabs' },
      { kind: 'kv', ref: 'view-state:task:T-empty' },
      { kind: 'kv', ref: 'view-state:task:T-empty:tabs' },
      { kind: 'terminal', ref: 'X-empty' },
    ])
  })

  it('tmux:会话、终端、后台、旧 emdash- 都改成新 pty id;不是 task 的 scope 和别人的会话不碰;认不出的留着计数', async () => {
    const { db, userData } = await migrated()
    const tmux = fakeTmux(liveNames())
    const summary = await runTaskToSessionOnce({ db, userData, tmux: tmux.tmux, roster: fakeRoster([]) })
    expect([...tmux.names].sort()).toEqual([
      tui('P:C-first:C-first'), bk('P:C-first:C-first'),
      tui('P:C-second:C-second'),
      tui('P:C-first:X-multi'),
      tui('P:C-solo:C-solo'), bk('P:C-solo:C-solo'),
      tui(LIVE.emptyTerminal),
      tui(LIVE.lifecycle),
      'user-own-session',
    ].sort())
    expect(summary!.tmux.unrecognized).toEqual([tui(LIVE.emptyTerminal)])
    expect(summary!.tmux.conflicts).toEqual([])
    // TUI 与它的后台在同一条 tmux 命令里改名(sweepOrphanTmuxBackends 不会看见只改了一半的那一对)
    const renameCalls = tmux.calls.filter((args) => args[0] === 'rename-session')
    const pair = renameCalls.find((args) => args.includes(`=${tui(LIVE.multiFirst)}`))!
    expect(pair).toContain(`=${bk(LIVE.multiFirst)}`)
    expect(renameCalls.every((args) => args.filter((a) => a.startsWith('=')).every((a) => a.length > 1))).toBe(true)
  })

  it('名册:只删 emdash_task_id,别的键原样', async () => {
    const { db, userData } = await migrated()
    const roster = fakeRoster([
      agent('u1', { emdash_task_id: 'T-multi', emdash_conversation_id: 'C-first', other: 1 }),
      agent('u2', { emdash_conversation_id: 'C-solo' }),
    ])
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster })
    expect(roster.agents.map((a) => a.cache)).toEqual([
      { emdash_conversation_id: 'C-first', other: 1 },
      { emdash_conversation_id: 'C-solo' },
    ])
    expect(summary!.roster.stripped).toBe(1)
  })

  it('无主 task:终端、视图状态计数进摘要;自有附件文件挪进迁移目录(内容不变),引用附件不碰', async () => {
    const { db, userData, ownedFile } = await migrated()
    const before = crypto.createHash('sha256').update(fs.readFileSync(ownedFile)).digest('hex')
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    const moved = path.join(userData, 'migrations', ORPHAN_DIR, 'T-empty', 'F-owned-owned.txt')
    expect(summary!.orphans).toEqual({
      terminals: ['X-empty'],
      kv: ['view-state:task:T-deleted-long-ago:tabs', 'view-state:task:T-empty', 'view-state:task:T-empty:tabs'],
      attachments: [
        { taskId: 'T-empty', id: 'F-owned', storedPath: ownedFile, origin: 'copy', movedTo: moved, note: undefined },
        { taskId: 'T-empty', id: 'F-ref', storedPath: '/Users/someone/ref.txt', origin: 'reference', movedTo: null, note: undefined },
      ],
    })
    expect(fs.existsSync(ownedFile)).toBe(false)
    expect(crypto.createHash('sha256').update(fs.readFileSync(moved)).digest('hex')).toBe(before)
    // 摘要落盘,与返回值一致
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'migrations', SUMMARY_FILE), 'utf8'))
    expect(onDisk.orphans.terminals).toEqual(['X-empty'])
    expect(onDisk.orphans.attachments).toHaveLength(2)
  })

  it('内置浏览器的隔离分区:改到代表会话名下(旧 emdash- 前缀直接改到新名字);新名已在两边不动;无主的挪走', async () => {
    const { db, userData } = await migrated()
    const partitions = path.join(userData, 'Partitions')
    const dirs = {
      multi: 'gugu-browser-isolated-P-W-T-multi',
      solo: 'emdash-browser-isolated-P-W-T-solo',
      home: `gugu-browser-isolated-${HOME}-W-T-home`,
      homeTaken: `gugu-browser-isolated-${HOME}-W-C-home`,
      empty: 'gugu-browser-isolated-P-W-T-empty',
      profile: 'gugu-browser-profile-work',
    }
    for (const dir of Object.values(dirs)) {
      fs.mkdirSync(path.join(partitions, dir, 'Local Storage'), { recursive: true })
      fs.writeFileSync(path.join(partitions, dir, 'Cookies'), dir)
    }
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(fs.readdirSync(partitions).sort()).toEqual([
      'gugu-browser-isolated-P-W-C-first',
      'gugu-browser-isolated-P-W-C-solo',
      dirs.home, dirs.homeTaken, dirs.profile,
    ].sort())
    // 目录是整个挪过去的:cookie 还是原来那份
    expect(fs.readFileSync(path.join(partitions, 'gugu-browser-isolated-P-W-C-first', 'Cookies'), 'utf8')).toBe(dirs.multi)
    expect(summary!.browserPartitions.conflicts).toEqual([{ from: dirs.home, to: dirs.homeTaken }])
    const movedTo = path.join(userData, 'migrations', ORPHAN_DIR, 'T-empty', `partition-${dirs.empty}`)
    expect(summary!.browserPartitions.orphaned).toEqual([{ from: dirs.empty, movedTo }])
    expect(fs.readFileSync(path.join(movedTo, 'Cookies'), 'utf8')).toBe(dirs.empty)
  })

  it('App「始终用它」:task:<认领> 改成 session:<认领>,值不动;新名字已在就留新的;group: 的不碰;没有这个文件就跳过', async () => {
    const { db, userData } = await migrated()
    const dir = path.join(userData, 'task-extensions')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '.open-with-defaults.json')
    fs.writeFileSync(file, JSON.stringify({ 'task:.csv': 'grid.main', 'task:todo.md': 'board.main', 'task:.md': 'old.main', 'session:.md': 'new.main', 'group:.md': 'g.main' }))
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(summary!.openWithKeysRenamed).toBe(3)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'session:.csv': 'grid.main', 'session:todo.md': 'board.main', 'session:.md': 'new.main', 'group:.md': 'g.main' })
  })

  it('App「始终用它」的文件不在:0 条,照常完成', async () => {
    const { db, userData } = await migrated()
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(summary!.openWithKeysRenamed).toBe(0)
  })

  it('摘要:会话数、task 数、standalone 两边不一致的明细', async () => {
    const { db, userData } = await migrated()
    const summary = await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(summary!.sessions).toBe(4)
    expect(summary!.tasks).toEqual({ total: 4, standalone: 1, withoutSession: 1 })
    expect(summary!.standaloneMismatch).toEqual({ standaloneOutsideHome: ['T-solo'], homeNotStandalone: ['T-home'] })
  })

  it('收尾:交接表 DROP、写 .done;再跑一次是 no-op', async () => {
    const { db, userData } = await migrated()
    await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'legacy_task_%'`).all()).toEqual([])
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
    expect(await runTaskToSessionOnce({ db, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })).toBeNull()
  })

  it('有一项失败:其余照做,整趟上抛,不 DROP、不写 .done;下次启动接着做完', async () => {
    const { db, userData, ownedFile } = await migrated()
    const tmux = fakeTmux(liveNames(), { failRename: tui(LIVE.solo) })
    await expect(runTaskToSessionOnce({ db, userData, tmux: tmux.tmux, roster: fakeRoster([]) })).rejects.toThrow(/will retry next start/)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(false)
    expect(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'legacy_task_%'`).get()).toEqual({ n: 2 })
    // 失败的那一对两边都还是旧名(同一条命令,要么都改要么都不改);别的已经改好
    expect(tmux.names.has(tui(LIVE.solo)) && tmux.names.has(bk(LIVE.solo))).toBe(true)
    expect(tmux.names.has(tui('P:C-first:C-first'))).toBe(true)
    expect(fs.existsSync(ownedFile)).toBe(false)

    const retry = fakeTmux([...tmux.names])
    const summary = await runTaskToSessionOnce({ db, userData, tmux: retry.tmux, roster: fakeRoster([]) })
    expect(summary!.tmux.renamed.map((pair) => pair.from).sort()).toEqual([bk(LIVE.solo), tui(LIVE.solo)].sort())
    expect(summary!.orphans.attachments[0]!.movedTo).toMatch(/F-owned-owned\.txt$/)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
  })

  it('列不出 tmux 会话(不是「没有服务器」)= 失败,不写 .done', async () => {
    const { db, userData } = await migrated()
    const tmux = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'permission denied' }) }
    await expect(runTaskToSessionOnce({ db, userData, tmux, roster: fakeRoster([]) })).rejects.toThrow(/cannot list tmux sessions/)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(false)
  })

  it('空库:交接表为空,照样收尾', async () => {
    const handle = openAt0031()
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-t2s-'))
    cleanups.push(() => { handle.close(); fs.rmSync(userData, { recursive: true, force: true }) })
    await initializeDatabase(handle.sqlite)
    const summary = await runTaskToSessionOnce({ db: handle.sqlite, userData, tmux: fakeTmux([]).tmux, roster: fakeRoster([]) })
    expect(summary!.tasks).toEqual({ total: 0, standalone: 0, withoutSession: 0 })
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
  })
})

describe('迁移前备份', () => {
  it('tasks 表在才备份,已有备份不覆盖;0032 跑完以后不再备份', async () => {
    const handle = openAt0031()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-t2s-bak-'))
    try {
      handle.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('P', 'p', '/p')`)
      const dbPath = path.join(dir, 'gugu4.db')
      const first = await backupBeforeTaskToSession(handle.sqlite, dbPath)
      expect(first).toBe(path.join(dir, 'gugu4.pre-session.db'))
      const copy = new Database(first!, { readonly: true })
      expect(copy.prepare('SELECT id FROM projects').all()).toEqual([{ id: 'P' }])
      expect(copy.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`).all()).toHaveLength(1)
      copy.close()
      const stamp = fs.statSync(first!).mtimeMs
      expect(await backupBeforeTaskToSession(handle.sqlite, dbPath)).toBeNull()
      expect(fs.statSync(first!).mtimeMs).toBe(stamp)
      fs.rmSync(first!)
      await initializeDatabase(handle.sqlite)
      expect(await backupBeforeTaskToSession(handle.sqlite, dbPath)).toBeNull()
    } finally {
      handle.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 真 tmux(私有套接字,❌ 碰机器上别的 tmux 服务器):`=` 精确匹配与 `;` 串联在真 tmux 上的语义,假 tmux 证明不了。
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true } catch { return false } })()
describe.skipIf(!hasTmux)('真 tmux', () => {
  it('成对改名落在真 tmux 上;前缀相同的别的会话不被误改', async () => {
    const label = `gugu-t2s-test-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    const run = (args: string[]) => execFileSync('tmux', ['-L', label, ...args], { encoding: 'utf8' })
    const handle = openAt0031()
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-t2s-'))
    try {
      seed(handle.sqlite, userData)
      await initializeDatabase(handle.sqlite)
      for (const name of [tui(LIVE.solo), bk(LIVE.solo), `${tui(LIVE.solo)}x`]) run(['new-session', '-d', '-s', name, 'sleep 600'])
      await runTaskToSessionOnce({
        db: handle.sqlite, userData, roster: fakeRoster([]),
        tmux: async (args) => run(args),
      })
      expect(run(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean).sort()).toEqual(
        [tui('P:C-solo:C-solo'), bk('P:C-solo:C-solo'), `${tui(LIVE.solo)}x`].sort()
      )
    } finally {
      // kill-server 不删套接字文件:按这条服务器自己报的路径删(❌ 按通配删别人的)。
      let socket = ''
      try { socket = run(['list-sessions', '-F', '#{socket_path}']).split('\n')[0]!.trim() } catch { /* 服务器已经没了 */ }
      try { run(['kill-server']) } catch { /* 服务器已经没了 */ }
      if (socket.endsWith(label)) fs.rmSync(socket, { force: true })
      handle.close()
      fs.rmSync(userData, { recursive: true, force: true })
    }
  })
})
