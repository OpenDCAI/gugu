// #7199 信息(imessage.* 6 个):读 = 只读查 chat.db(用真的 sqlite3 跑在一份按真实表结构造的库上),发 = JXA。
// 验:attributedBody 解码(真 NSArchiver 产出的字节)、两种时间单位、会话 / 搜索 / 未读的 SQL、没给完全磁盘访问权限的报法、
// 连接要两样权限都通、发送的确认问句 / 发后查投递结果 / 文件只认连上的位置且「信息」读不到的先拷进「图片」。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import {
  appleDate,
  appleNanos,
  createMessagesFamily,
  MESSAGES_SCRIPTS,
  textFromAttributedBody,
} from '../../../../apps/desktop/electron/device-actions/families/messages'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { execFileAsync, MacScriptPermissionError, type ExecResult } from '../../../../apps/desktop/electron/device-actions/mac-scripts'
import type { CuaClient } from '../../../../apps/desktop/electron/device-actions/native/cua-client'
import type { MacHelperClient } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

/** NSArchiver 归档的 NSMutableAttributedString(osascript + Foundation 真生成):正文「你好 hello 👋」,长度一个字节。 */
const BLOB_SHORT = '040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b11e4bda0e5a5bd2068656c6c6f20f09f918b8684026949010b928484840c4e5344696374696f6e617279009584016901928498981d5f5f6b494d4d657373616765506172744174747269627574654e616d658692848484084e534e756d626572008484074e5356616c7565009584012a849b9b00868686'
/** 同上,正文「\uFFFC看这张图」(带附件的消息:占位符 + 文字)。 */
const BLOB_ATTACHMENT = '040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e5341747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e67018484084e53537472696e67019584012b0fefbfbce79c8be8bf99e5bca0e59bbe86840269490105928484840c4e5344696374696f6e617279009584016901928498981d5f5f6b494d4d657373616765506172744174747269627574654e616d658692848484084e534e756d626572008484074e5356616c7565009584012a849b9b00868686'
/** 真字节流里 '+' 之前的那一段(类名链),用来拼长正文:0x81 + 2 字节 / 0x82 + 4 字节的长度。 */
const PREFIX = BLOB_SHORT.slice(0, BLOB_SHORT.indexOf('2b11') + 2)
const blobWith = (text: string) => {
  const body = Buffer.from(text, 'utf8')
  const len = body.length < 0x80 ? Buffer.from([body.length])
    : body.length < 0x8000 ? Buffer.concat([Buffer.from([0x81]), Buffer.from(new Uint16Array([body.length]).buffer)])
      : Buffer.concat([Buffer.from([0x82]), Buffer.from(new Uint32Array([body.length]).buffer)])
  return PREFIX + len.toString('hex') + body.toString('hex') + '8684'
}

const APPLE_EPOCH = Date.UTC(2001, 0, 1)
const nsAgo = (ms: number) => appleNanos(Date.now() - ms)

const SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, attributedBody BLOB, service TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
`

let dir: string
let home: string
let db: string
const realHome = process.env.HOME

function sql(statement: string) {
  execFileSync('/usr/bin/sqlite3', [db, statement], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function insertMessage(m: { id: number; chat: number; handle: number; text?: string | null; blob?: string; date: string; fromMe?: boolean; read?: boolean; sent?: boolean; error?: number; att?: boolean; itemType?: number; amt?: number }) {
  sql(`INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, service, date, is_from_me, is_read, is_sent, error, cache_has_attachments, item_type, associated_message_type)
VALUES (${m.id}, 'G${m.id}', ${m.text === undefined || m.text === null ? 'NULL' : `'${m.text.replace(/'/g, "''")}'`}, ${m.blob ? `X'${m.blob}'` : 'NULL'}, ${m.handle}, 'iMessage', ${m.date},
 ${m.fromMe ? 1 : 0}, ${m.read ? 1 : 0}, ${m.sent ? 1 : 0}, ${m.error ?? 0}, ${m.att ? 1 : 0}, ${m.itemType ?? 0}, ${m.amt ?? 0});
INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (${m.chat}, ${m.id}, ${m.date});`)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-imsg-'))
  home = fs.realpathSync(dir) + '/home'
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Library/Messages']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, 'Desktop', '合同.pdf'), 'pdf')
  fs.writeFileSync(path.join(home, 'Documents', '照片.jpg'), 'jpg')
  process.env.HOME = home
  db = path.join(home, 'Library/Messages/chat.db')
  sql(`${SCHEMA}
INSERT INTO handle (ROWID, id, service) VALUES (1, '+8613800001234', 'iMessage'), (2, 'alice@example.com', 'iMessage'), (3, '+15551234567', 'iMessage');
INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES (1, 'iMessage;-;+8613800001234', 45, '+8613800001234', 'iMessage', ''), (2, 'iMessage;+;chat111', 43, 'chat111', 'iMessage', '家庭群');
INSERT INTO chat_handle_join VALUES (1, 1), (2, 2), (2, 3);
INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES (1, 'A1', '~/Library/Messages/Attachments/ab/IMG_1.heic', 'image/heic', 'IMG_1.heic', 12345);
INSERT INTO message_attachment_join VALUES (3, 1);`)
  insertMessage({ id: 1, chat: 1, handle: 1, text: null, blob: BLOB_SHORT, date: nsAgo(3 * 3600_000) })
  insertMessage({ id: 2, chat: 1, handle: 1, text: '收到,明天见', date: nsAgo(2 * 3600_000), fromMe: true, sent: true })
  insertMessage({ id: 3, chat: 1, handle: 1, text: '\uFFFC', blob: BLOB_ATTACHMENT, date: nsAgo(3600_000), att: true })
  insertMessage({ id: 4, chat: 1, handle: 1, text: 'Liked “收到,明天见”', date: nsAgo(1800_000), read: true, amt: 2001 })
  insertMessage({ id: 5, chat: 2, handle: 2, text: 'Dinner at 7?', date: nsAgo(600_000) })
  // 老系统存的是秒。
  insertMessage({ id: 6, chat: 2, handle: 3, text: 'old one', date: String(Math.round((Date.UTC(2015, 5, 1) - APPLE_EPOCH) / 1000)), read: true })
  // 系统消息(改群名之类)不算消息。
  insertMessage({ id: 7, chat: 2, handle: 2, text: null, date: nsAgo(300_000), itemType: 2 })
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

type Jxa = (script: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; app: string }) => Promise<unknown>
type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>

const realExec: Exec = async (file, args) => (file === '/usr/bin/sqlite3' ? execFileAsync(file, args) : { stdout: '', stderr: '', code: 0 })

function setup(jxaImpl: Jxa = async () => ({ sent: true }), execImpl: Exec = realExec) {
  const store = createDeviceActionGrantsStore(path.join(dir, 'grants.json'))
  const jxa = vi.fn(jxaImpl)
  const exec = vi.fn(execImpl)
  const deps: FamilyDeps = {
    platform: 'darwin',
    nativeDir: null,
    now: () => new Date(),
    homedir: () => home,
    clipboardRead: () => '',
    clipboardWrite: () => undefined,
    notify: () => undefined,
    openExternal: async () => undefined,
    trashItem: async () => undefined,
    jxa: jxa as unknown as FamilyDeps['jxa'],
    exec,
    macHelper: () => ({ available: () => ({ ok: true }), call: vi.fn(), dispose: () => undefined }) as unknown as MacHelperClient,
    cua: () => ({ available: () => ({ ok: true }), callTool: vi.fn(), stop: () => undefined, dispose: () => undefined }) as unknown as CuaClient,
  }
  const da = createDeviceActionsProvider({ store, families: [createMessagesFamily()], deps })
  store.setGroup('messages', true)
  return { da, store, jxa, exec }
}

const ctx = () => ({ callId: 'c', signal: new AbortController().signal, note: () => undefined })
const data = <T>(r: { ok: boolean; data?: unknown }) => {
  expect(r.ok).toBe(true)
  return r.data as T
}
const FDA_DENIED: Exec = async (file, args) => (file === '/usr/bin/sqlite3'
  ? { stdout: '', stderr: `Error: unable to open database "${args[2]}": authorization denied\n`, code: 1 }
  : { stdout: '', stderr: '', code: 0 })

describe('信息 imessage.*', () => {
  it('attributedBody:真 NSArchiver 字节里取出正文(长度 1 字节 / 0x81 两字节 / 0x82 四字节);不是 typedstream → null', () => {
    expect(textFromAttributedBody(BLOB_SHORT)).toBe('你好 hello 👋')
    expect(textFromAttributedBody(BLOB_ATTACHMENT)).toBe('\uFFFC看这张图')
    const medium = `${'a'.repeat(200)}中`
    expect(textFromAttributedBody(blobWith(medium))).toBe(medium)
    const long = '长'.repeat(40_000)
    expect(textFromAttributedBody(blobWith(long))).toBe(long)
    expect(textFromAttributedBody('deadbeef')).toBeNull()
    expect(textFromAttributedBody(null)).toBeNull()
  })

  it('时间:纳秒与秒按大小判,都换成同一刻', () => {
    const at = Date.UTC(2026, 9, 15, 2, 0, 0)
    expect(appleDate(Number(appleNanos(at)))!.getTime()).toBe(at)
    expect(appleDate((at - APPLE_EPOCH) / 1000)!.getTime()).toBe(at)
    expect(appleDate(0)).toBeNull()
  })

  it('登记 6 个工具:发的两个每次都问;读的不问', () => {
    const { da } = setup()
    const actions = da.capability()!.actions
    expect(actions.map((a) => a.name).sort()).toEqual(['imessage.chats.list', 'imessage.conversation.get', 'imessage.search', 'imessage.send', 'imessage.send_file', 'imessage.unread'])
    expect(actions.filter((a) => a.confirm === 'always').map((a) => a.name).sort()).toEqual(['imessage.send', 'imessage.send_file'])
  })

  it.runIf(process.platform === 'darwin' && fs.existsSync('/usr/bin/osacompile'))('JXA 脚本能编译', () => {
    for (const [name, script] of Object.entries(MESSAGES_SCRIPTS)) {
      const file = path.join(dir, `${name}.js`)
      fs.writeFileSync(file, script)
      expect(() => execFileSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(dir, `${name}.scpt`), file], { stdio: 'pipe' }), name).not.toThrow()
    }
  })

  it('会话列表:最近的在前;群名、参与者(原始号码)、未读数(系统消息不算)', async () => {
    const { da } = setup()
    const d = data<{ chats: Array<Record<string, unknown>> }>(await da.provider.run('imessage.chats.list', {}, ctx()))
    expect(d.chats).toEqual([
      expect.objectContaining({ chat_id: 'iMessage;+;chat111', name: '家庭群', is_group: true, participants: ['alice@example.com', '+15551234567'], unread: 1 }),
      expect.objectContaining({ chat_id: 'iMessage;-;+8613800001234', name: null, is_group: false, participants: ['+8613800001234'], unread: 2 }),
    ])
    const dms = data<{ chats: unknown[] }>(await da.provider.run('imessage.chats.list', { type: 'dm', search: "1380000'" }, ctx()))
    expect(dms.chats).toHaveLength(0)
    const found = data<{ chats: Array<{ chat_id: string }> }>(await da.provider.run('imessage.chats.list', { search: 'alice' }, ctx()))
    expect(found.chats.map((c) => c.chat_id)).toEqual(['iMessage;+;chat111'])
  })

  it('读对话:号码写法不同也认(138 0000 1234 ≈ +8613800001234);正文从 attributedBody 解出;从旧到新;附件给本地路径', async () => {
    const { da } = setup()
    const d = data<{ conversations: Array<{ chat: { chat_id: string }; messages: Array<Record<string, unknown>> }> }>(
      await da.provider.run('imessage.conversation.get', { contact: '138 0000 1234' }, ctx()))
    expect(d.conversations).toHaveLength(1)
    const [conv] = d.conversations
    expect(conv!.chat.chat_id).toBe('iMessage;-;+8613800001234')
    expect(conv!.messages.map((m) => m.text)).toEqual(['你好 hello 👋', '收到,明天见', '看这张图', 'Liked “收到,明天见”'])
    expect(conv!.messages[1]).toMatchObject({ from_me: true, sender: 'me' })
    expect(conv!.messages[0]).toMatchObject({ from_me: false, sender: '+8613800001234', read: false })
    expect(conv!.messages[2]!.attachments).toEqual([{ name: 'IMG_1.heic', mime_type: 'image/heic', size: 12345, path: `${home}/Library/Messages/Attachments/ab/IMG_1.heic` }])
    expect(conv!.messages[3]).toMatchObject({ reaction: 'like' })
    expect(String(conv!.messages[0]!.time)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
    const recent = data<{ conversations: Array<{ messages: unknown[] }> }>(
      await da.provider.run('imessage.conversation.get', { contact: '+8613800001234', since: new Date(Date.now() - 90 * 60_000).toISOString() }, ctx()))
    expect(recent.conversations[0]!.messages).toHaveLength(2)
    const missing = await da.provider.run('imessage.conversation.get', { contact: '张三' }, ctx())
    expect(missing).toMatchObject({ ok: false, code: 'invalid_args', message: expect.stringContaining('Contacts lookup is not available') })
  })

  it('搜索:正文只在 attributedBody 里的也搜得到;按发件人;老消息(秒)的时间也对', async () => {
    const { da } = setup()
    const hello = data<{ messages: Array<{ id: number; text: string }> }>(await da.provider.run('imessage.search', { search: 'hello' }, ctx()))
    expect(hello.messages.map((m) => m.id)).toEqual([1])
    const dinner = data<{ messages: Array<{ id: number; chat_id: string; chat_name: string }> }>(await da.provider.run('imessage.search', { search: 'dinner' }, ctx()))
    expect(dinner.messages).toEqual([expect.objectContaining({ id: 5, chat_id: 'iMessage;+;chat111', chat_name: '家庭群' })])
    const old = data<{ messages: Array<{ time: string }> }>(await da.provider.run('imessage.search', { sender: '5551234567' }, ctx()))
    expect(old.messages).toHaveLength(1)
    expect(old.messages[0]!.time.startsWith('2015-06-01') || old.messages[0]!.time.startsWith('2015-05-31')).toBe(true)
    const noReactions = data<{ messages: Array<{ id: number }> }>(await da.provider.run('imessage.search', { excludeReactions: true, excludeOwnMessages: true }, ctx()))
    expect(noReactions.messages.map((m) => m.id)).toEqual([5, 3, 1, 6])
  })

  it('未读:按发件人分组,最新在前;超过 limit 标 truncated', async () => {
    const { da } = setup()
    const d = data<{ total: number; sender_count: number; truncated: boolean; groups: Array<{ sender: string; messages: Array<{ id: number }> }> }>(
      await da.provider.run('imessage.unread', {}, ctx()))
    expect(d).toMatchObject({ total: 3, sender_count: 2, truncated: false })
    expect(d.groups.map((g) => [g.sender, g.messages.map((m) => m.id)])).toEqual([['alice@example.com', [5]], ['+8613800001234', [3, 1]]])
    expect(data<{ truncated: boolean; total: number }>(await da.provider.run('imessage.unread', { limit: 2 }, ctx()))).toMatchObject({ total: 2, truncated: true })
  })

  it('没给完全磁盘访问权限:读 → os_permission 并说去哪打开;「连接」也不记成连上', async () => {
    const { da, store } = setup(undefined, FDA_DENIED)
    const r = await da.provider.run('imessage.unread', {}, ctx())
    expect(r).toMatchObject({ ok: false, code: 'os_permission', message: expect.stringContaining('完全磁盘访问权限 → 打开咕咕') })
    store.setGroup('messages', false)
    const c = await da.connect('messages')
    expect(c).toMatchObject({ ok: false, code: 'os_permission' })
    expect(!c.ok && c.settingsUrl).toContain('Privacy_AllFiles')
    expect(store.read().groups.messages).toBeUndefined()
  })

  it('还没用过「信息」(没有 chat.db)→ 说清要先打开「信息」,❌ 当成权限问题', async () => {
    fs.rmSync(db)
    const { da } = setup()
    expect(await da.provider.run('imessage.chats.list', {}, ctx())).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('open the Messages app') })
  })

  it('连接要两样都通:库能读但「信息」不让控制 → os_permission;都通才连上', async () => {
    const denied = setup(async () => { throw new MacScriptPermissionError('信息', '-1743') })
    denied.store.setGroup('messages', false)
    expect(await denied.da.connect('messages')).toMatchObject({ ok: false, code: 'os_permission' })
    const fine = setup(async () => ({ services: ['iMessage'] }))
    fine.store.setGroup('messages', false)
    expect(await fine.da.connect('messages')).toEqual({ ok: true })
    expect(fine.jxa.mock.calls[0]![0]).toContain("Application('Messages').accounts.serviceType()")
  })

  it('发 iMessage:先问「要给谁发什么」;to 不像号码 / 邮箱 → invalid_args', async () => {
    const { da } = setup()
    expect(await da.provider.preflight!('imessage.send', { to: '+8613800001234', text: '今晚七点老地方见,别迟到啊,我已经订好位子了,靠窗那桌' }))
      .toMatchObject({ code: 'needs_confirmation', confirm: { question: '要给 +8613800001234 发 iMessage「今晚七点老地方见,别迟到啊,我已经订好位子了,靠窗那桌」吗？' } })
    const long = 'x'.repeat(60)
    expect(await da.provider.preflight!('imessage.send', { to: 'a@b.com', text: long })).toMatchObject({ confirm: { question: `要给 a@b.com 发 iMessage「${'x'.repeat(40)}…」吗？` } })
    expect(await da.provider.preflight!('imessage.send', { to: '张三', text: 'hi' })).toMatchObject({ code: 'invalid_args' })
    expect(await da.provider.preflight!('imessage.send', { to: '+8613800001234' })).toMatchObject({ code: 'invalid_args' })
    expect(await da.provider.preflight!('imessage.send_file', { to: 'iMessage;+;chat111', paths: ['~/Desktop/合同.pdf'], text: '请查收' }))
      .toMatchObject({ code: 'needs_confirmation', confirm: { question: '要通过 iMessage 给 iMessage;+;chat111 发送文件 合同.pdf 吗？附言「请查收」' } })
  })

  it('发出后去 chat.db 看投递:发出去了 → sent;对方没有 iMessage(带 error)→ execution_failed 说清没送达', async () => {
    const writes = (error: number): Jxa => async (_s, input) => {
      insertMessage({ id: 50 + error, chat: 1, handle: 1, text: (input as { text: string }).text, date: nsAgo(0), fromMe: true, sent: error === 0, error })
      return { sent: true }
    }
    const good = setup(writes(0))
    const r = await good.da.provider.run('imessage.send', { to: '+86 138 0000 1234', text: '到了吗', confirmed: true }, ctx())
    expect(r).toMatchObject({ ok: true, data: { to: '+86 138 0000 1234', status: 'sent' } })
    expect(good.jxa.mock.calls[0]![1]).toEqual({ to: '+86 138 0000 1234', chatId: undefined, text: '到了吗', files: [] })
    expect(good.jxa.mock.calls[0]![2]).toMatchObject({ app: '信息' })

    const bad = setup(writes(22))
    const r2 = await bad.da.provider.run('imessage.send', { to: '+8613800001234', text: '在吗', confirmed: true }, ctx())
    expect(r2).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('not reachable over iMessage') })
  })

  it('已经发出去、但发后读不了库(权限被收回)→ 仍回 ok + unconfirmed 并叮嘱别重发,❌ 报成失败', async () => {
    const { da, jxa } = setup(async () => ({ sent: true }), FDA_DENIED)
    const r = await da.provider.run('imessage.send', { to: 'alice@example.com', text: 'hi', confirmed: true }, ctx())
    expect(r).toMatchObject({ ok: true, data: { status: 'unconfirmed', note: expect.stringContaining('Do not send it again') } })
    expect(jxa).toHaveBeenCalledTimes(1)
    expect(da.blocked('messages')).toBeNull()
  })

  it('发到群:chat111 这种标识先换成 chat_id;发文件只认连上的位置,桌面上的先拷进「图片」再发,旧拷贝清掉', async () => {
    const { da, store, jxa } = setup(async (_s, input) => {
      const files = (input as { files: string[] }).files
      files.forEach((_f, i) => insertMessage({ id: 60 + i, chat: 2, handle: 0, text: null, date: nsAgo(0), fromMe: true, sent: true, att: true }))
      return { sent: true }
    })
    const args = { to: 'chat111', paths: ['~/Desktop/合同.pdf', '~/Documents/照片.jpg'], confirmed: true }
    expect(await da.provider.run('imessage.send_file', args, ctx())).toMatchObject({ ok: false, code: 'not_granted', message: expect.stringContaining('connect the location') })
    store.setGroup('files.documents', true)
    expect(await da.provider.run('imessage.send_file', args, ctx())).toMatchObject({ ok: false, code: 'invalid_args' })
    store.setGroup('files.desktop', true)
    const pictures = path.join(home, 'Pictures')
    fs.mkdirSync(pictures, { recursive: true })
    const stale = path.join(pictures, 'gugu_imsg_old_x.pdf')
    fs.writeFileSync(stale, 'old')
    fs.utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000))
    const r = await da.provider.run('imessage.send_file', args, ctx())
    expect(r).toMatchObject({ ok: true, data: { status: 'sent', files: ['合同.pdf', '照片.jpg'] } })
    const input = jxa.mock.calls[0]![1] as { chatId: string; files: string[] }
    expect(input.chatId).toBe('iMessage;+;chat111')
    expect(path.dirname(input.files[0]!)).toBe(pictures)
    expect(path.basename(input.files[0]!)).toMatch(/^gugu_imsg_[0-9a-f]{8}_合同\.pdf$/)
    expect(fs.readFileSync(input.files[0]!, 'utf8')).toBe('pdf')
    expect(input.files[1]).toBe(path.join(home, 'Documents', '照片.jpg'))
    expect(fs.existsSync(stale)).toBe(false)
  })
})
