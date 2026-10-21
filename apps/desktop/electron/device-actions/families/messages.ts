/**
 * 信息(imessage.* 6 个):读 = 直接只读查「信息」的数据库 ~/Library/Messages/chat.db(要「完全磁盘访问权限」),
 * 发 = JXA 驱动「信息」App(要「自动化 → 信息」)。两样都通了「连接」才算成功。
 * 这里没有通讯录:对方一律回原始号码 / 邮箱(群聊回群名),按名字找人只能靠群名。
 * chat.db 的坑:时间是 2001-01-01 起的秒或纳秒(按大小判);新系统上很多消息 text 是空的、内容在 attributedBody
 * (typedstream 二进制)里 —— SQL 里 hex() 取出来,在这里解出 NSString 那一段。
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { bad, bool, clampInt, fail, isDate, MAC_PRIVACY, num, ok, str, TIME_HINT, type ActionDef, type ActionFamily, type Args, type FamilyContext, type Outcome } from '../catalog'
import { FILE_ROOTS, resolveInsideRoots } from '../paths'

const APP = '信息'
const SQLITE = '/usr/bin/sqlite3'
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const TEXT_MAX = 2000
/** 发完去 chat.db 看投递结果:每 700 毫秒看一次,最多看 10 次。 */
const SEND_CHECK_DELAY_MS = 700
const SEND_CHECK_TRIES = 10
/** 「信息」是沙盒 App,只读得到 图片 / 下载 / 文稿 里的文件;别处的先拷一份到「图片」里再发,10 分钟后清掉(照 imessage-kit)。 */
const SEND_COPY_PREFIX = 'gugu_imsg_'
const SEND_COPY_KEEP_MS = 10 * 60_000

const FDA_MESSAGE = '咕咕 has no Full Disk Access, which reading Messages needs: on this computer open 系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 打开咕咕, then retry.'

const REACTIONS: Record<number, string> = { 2000: 'love', 2001: 'like', 2002: 'dislike', 2003: 'laugh', 2004: 'emphasize', 2005: 'question' }

// ---------- chat.db ----------

class MessagesDbError extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.ok ? 'ok' : outcome.message)
  }
}

const chatDb = (ctx: FamilyContext) => path.join(ctx.deps.homedir(), 'Library', 'Messages', 'chat.db')

async function dbFailure(stderr: string, db: string): Promise<Outcome> {
  const text = stderr.trim()
  if (/authorization denied|operation not permitted|not authori[sz]ed/i.test(text)) return fail('os_permission', FDA_MESSAGE)
  if (/unable to open/i.test(text)) {
    const code = await fsp.access(db).then(() => null, (error: NodeJS.ErrnoException) => error.code ?? 'UNKNOWN')
    if (code === 'EPERM' || code === 'EACCES') return fail('os_permission', FDA_MESSAGE)
    if (code === 'ENOENT') return fail('execution_failed', 'This Mac has no Messages database yet: open the Messages app and sign in to iMessage once, then retry.')
  }
  return fail('execution_failed', `Reading the Messages database failed: ${text.slice(0, 300) || 'sqlite3 exited without a message'}`)
}

/** 只读跑一条 SQL,回 JSON 行。打不开库(没给完全磁盘访问权限 …)抛 MessagesDbError,由 withDb 收成结果。 */
async function query<T>(ctx: FamilyContext, sql: string): Promise<T[]> {
  const db = chatDb(ctx)
  const r = await ctx.deps.exec(SQLITE, ['-readonly', '-json', db, sql], { signal: ctx.signal, timeoutMs: 60_000 })
  if (r.code !== 0) throw new MessagesDbError(await dbFailure(r.stderr || r.stdout, db))
  const text = r.stdout.trim()
  return text ? (JSON.parse(text) as T[]) : []
}

async function withDb(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof MessagesDbError) return error.outcome
    throw error
  }
}

/** SQL 字面量(sqlite3 命令行没有参数绑定):单引号加倍、去掉 NUL。 */
export const sqlText = (value: string) => `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`
/** LIKE 的「包含」模式,% _ \ 转义(配 ESCAPE '\')。 */
const sqlContains = (value: string) => `${sqlText(`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} ESCAPE '\\'`
const sqlHex = (value: string) => `X'${Buffer.from(value, 'utf8').toString('hex')}'`

/** chat.db 的时间:2001-01-01 起,老系统存秒、新系统存纳秒(按大小判)。 */
export function appleDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return null
  return new Date(APPLE_EPOCH_MS + (Math.abs(value) > 1e12 ? value / 1e6 : value * 1000))
}
/** 某一刻在 chat.db 里的纳秒写法(超过 2^53,用 BigInt 拼)。 */
export const appleNanos = (ms: number) => (BigInt(Math.round(ms - APPLE_EPOCH_MS)) * 1_000_000n).toString()
/** message.date 统一成纳秒(秒的乘上去),用来和 appleNanos 比。 */
const DATE_NS = '(CASE WHEN m.date > 1000000000000 OR m.date < -1000000000000 THEN m.date ELSE m.date * 1000000000 END)'

export function localIso(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const off = -date.getTimezoneOffset()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}

/**
 * 从 attributedBody(NSArchiver typedstream)里取出正文:找到类名 "NSString",后面几个字节内的 '+'(0x2b)之后是长度 ——
 * 一个字节;0x81 开头 = 后面 2 字节小端;0x82 开头 = 后面 4 字节小端 —— 再往后就是那么长的 UTF-8。
 */
export function textFromAttributedBody(hex: string | null | undefined): string | null {
  if (!hex) return null
  const buf = Buffer.from(hex, 'hex')
  const marker = buf.indexOf('NSString')
  if (marker < 0) return null
  let i = buf.indexOf(0x2b, marker + 8)
  if (i < 0 || i > marker + 16) return null
  i += 1
  let length = buf[i]
  i += 1
  if (length === 0x81) {
    length = buf.readUInt16LE(i)
    i += 2
  } else if (length === 0x82) {
    length = buf.readUInt32LE(i)
    i += 4
  }
  if (length === undefined || i + length > buf.length) return null
  return buf.subarray(i, i + length).toString('utf8')
}

/** 正文:去掉附件占位符(U+FFFC),空的回 null。 */
const cleanText = (value: string | null | undefined) => {
  const text = (value ?? '').replace(/￼/g, '').trim()
  return text ? text : null
}

interface MessageRow {
  id: number
  text: string | null
  ab: string | null
  date: number | null
  is_from_me: number
  is_read: number
  service: string | null
  amt: number | null
  has_att: number
  error: number | null
  sender: string | null
  chat_guid: string | null
  chat_name: string | null
}

interface AttachmentRow { mid: number; filename: string | null; name: string | null; mime: string | null; size: number | null }

export interface MessageOut {
  id: number
  time: string | null
  from_me: boolean
  sender: string
  text: string | null
  truncated?: boolean
  service: string
  read?: boolean
  reaction?: string
  reaction_removed?: boolean
  not_delivered?: boolean
  chat_id?: string | null
  chat_name?: string | null
  attachments?: Array<{ name: string; mime_type: string | null; size: number; path: string | null }>
}

function messageSql(where: string[], limit: number): string {
  return `SELECT m.ROWID AS id, m.text,
  CASE WHEN (m.text IS NULL OR trim(replace(m.text, char(65532), '')) = '') AND m.attributedBody IS NOT NULL THEN hex(m.attributedBody) END AS ab,
  m.date, m.is_from_me, m.is_read, m.service, m.associated_message_type AS amt, m.cache_has_attachments AS has_att, m.error,
  h.id AS sender, c.guid AS chat_guid, c.display_name AS chat_name
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = j.chat_id
WHERE m.item_type = 0${where.map((w) => ` AND ${w}`).join('')}
ORDER BY m.date DESC
LIMIT ${limit}`
}

async function loadMessages(ctx: FamilyContext, where: string[], limit: number, withChat: boolean): Promise<MessageOut[]> {
  const rows = await query<MessageRow>(ctx, messageSql(where, limit))
  const withFiles = rows.filter((r) => r.has_att).map((r) => Number(r.id)).filter(Number.isSafeInteger)
  const files = withFiles.length
    ? await query<AttachmentRow>(ctx, `SELECT maj.message_id AS mid, a.filename, a.transfer_name AS name, a.mime_type AS mime, a.total_bytes AS size
FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id IN (${withFiles.join(',')})`)
    : []
  const home = ctx.deps.homedir()
  return rows.map((r) => {
    const full = cleanText(r.text) ?? cleanText(textFromAttributedBody(r.ab))
    const amt = Number(r.amt) || 0
    const reaction = REACTIONS[amt] ?? REACTIONS[amt - 1000]
    const out: MessageOut = {
      id: r.id,
      time: localIso(appleDate(r.date)),
      from_me: r.is_from_me === 1,
      sender: r.is_from_me === 1 ? 'me' : r.sender ?? 'unknown',
      text: full === null ? null : full.slice(0, TEXT_MAX),
      service: r.service ?? 'iMessage',
    }
    if (full !== null && full.length > TEXT_MAX) out.truncated = true
    if (r.is_from_me !== 1) out.read = r.is_read === 1
    if (reaction) {
      out.reaction = reaction
      if (amt >= 3000) out.reaction_removed = true
    }
    if (r.is_from_me === 1 && r.error) out.not_delivered = true
    if (withChat) {
      out.chat_id = r.chat_guid
      if (r.chat_name) out.chat_name = r.chat_name
    }
    const mine = files.filter((f) => f.mid === r.id)
    if (mine.length) {
      out.attachments = mine.map((f) => ({
        name: f.name ?? (f.filename ? path.basename(f.filename) : 'attachment'),
        mime_type: f.mime,
        size: Number(f.size) || 0,
        path: f.filename ? f.filename.replace(/^~(?=\/)/, home) : null,
      }))
    }
    return out
  })
}

/** 号码只比数字(+86 138-0000-0000 ≈ 13800000000):任一方的数字是另一方的结尾就算同一个号。 */
const digitsOf = (column: string) => `replace(replace(replace(replace(replace(${column}, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')`
const PHONE = /^\+?[\d\s\-().]{5,}$/
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function handleMatch(column: string, handle: string): string {
  if (EMAIL.test(handle)) return `lower(${column}) = lower(${sqlText(handle)})`
  const digits = handle.replace(/\D/g, '')
  if (PHONE.test(handle) && digits.length >= 5) {
    return `(${column} = ${sqlText(handle)} OR ${digitsOf(column)} LIKE ${sqlText(`%${digits}`)} OR (length(${digitsOf(column)}) >= 7 AND ${sqlText(digits)} LIKE '%' || ${digitsOf(column)}))`
  }
  return `${column} = ${sqlText(handle)}`
}

/** 会话 id:chat.guid(iMessage;+;chat123… / any;-;+86…)或 chat_identifier(chat123… / 号码 / 邮箱)。 */
function chatMatch(value: string): string {
  if (value.includes(';')) return `c.guid = ${sqlText(value)}`
  if (EMAIL.test(value) || PHONE.test(value)) return handleMatch('c.chat_identifier', value)
  return `c.chat_identifier = ${sqlText(value)}`
}

interface ChatRow { rowid: number; guid: string; identifier: string | null; service: string | null; name: string | null; is_group: number; handles: string | null; last_date: number | null; unread: number }

function chatSql(where: string[], order: 'recent' | 'name', limit: number): string {
  return `WITH unread AS (
  SELECT j.chat_id, COUNT(*) AS n FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
  WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0 GROUP BY j.chat_id
), last AS (SELECT chat_id, MAX(message_date) AS d FROM chat_message_join GROUP BY chat_id)
SELECT c.ROWID AS rowid, c.guid, c.chat_identifier AS identifier, c.service_name AS service, c.display_name AS name,
  (c.style = 43 OR (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) > 1) AS is_group,
  (SELECT json_group_array(id) FROM (SELECT h.id FROM chat_handle_join x JOIN handle h ON h.ROWID = x.handle_id WHERE x.chat_id = c.ROWID ORDER BY h.ROWID)) AS handles,
  l.d AS last_date, COALESCE(u.n, 0) AS unread
FROM chat c LEFT JOIN unread u ON u.chat_id = c.ROWID LEFT JOIN last l ON l.chat_id = c.ROWID
WHERE 1 = 1${where.map((w) => ` AND ${w}`).join('')}
ORDER BY ${order === 'name' ? "(c.display_name IS NULL OR c.display_name = ''), c.display_name, c.chat_identifier" : 'l.d IS NULL, l.d DESC'}
LIMIT ${limit}`
}

/**
 * 参与者在 SQL 里就拼成 JSON 数组(json_group_array),这里 JSON.parse。
 * ❌ group_concat + 控制字符当分隔符:各版本 sqlite3 -json 对控制字符的转义不一样(Linux 上出来是字面的「u001f」,反斜杠丢了)。
 */
const participantsOf = (raw: string | null): string[] => {
  const parsed: unknown = raw ? JSON.parse(raw) : []
  return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string' && h !== '') : []
}

const chatOut = (c: ChatRow) => {
  const participants = participantsOf(c.handles)
  return {
    chat_id: c.guid,
    name: c.name || null,
    identifier: c.identifier,
    service: c.service,
    is_group: c.is_group === 1,
    participants: participants.slice(0, 20),
    ...(participants.length > 20 ? { participants_total: participants.length } : {}),
    last_message_at: localIso(appleDate(c.last_date)),
    unread: Number(c.unread) || 0,
  }
}

// ---------- 发送 ----------

/** 「信息」没开着就先在后台隐藏启动;开着就不碰。 */
async function launchHidden(ctx: FamilyContext) {
  const running = await ctx.deps.exec('/usr/bin/pgrep', ['-x', 'Messages'], { signal: ctx.signal, timeoutMs: 5000 })
  if (running.code === 0) return
  await ctx.deps.exec('/usr/bin/open', ['-g', '-j', '-b', 'com.apple.MobileSMS'], { signal: ctx.signal, timeoutMs: 15_000 })
}

/**
 * 发给一个人:取第一个开着的 iMessage 账户,`participant "号码" of account`(和 AppleScript 的经典写法同一个对象);
 * 发到群:`chat id "…"`。文字先发,文件一个一个发。找不到对象(-1728)回 not_found,别的错照样抛。
 */
const SEND_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Messages')
  let target = null
  if (p.chatId) {
    target = app.chats.byId(p.chatId)
    try { target.id() } catch (e) { if (e && e.errorNumber === -1728) return JSON.stringify({ error: 'chat_not_found' }); throw e }
  } else {
    const ids = app.accounts.id()
    const types = app.accounts.serviceType()
    const enabled = app.accounts.enabled()
    let k = -1
    for (let i = 0; i < ids.length; i++) if (String(types[i]) === 'iMessage' && enabled[i] !== false) { k = i; break }
    if (k < 0) return JSON.stringify({ error: 'no_imessage_account' })
    target = app.accounts.byId(ids[k]).participants.byName(p.to)
  }
  try {
    if (p.text) app.send(p.text, { to: target })
    for (const f of p.files) app.send(Path(f), { to: target })
  } catch (e) {
    if (e && e.errorNumber === -1728) return JSON.stringify({ error: 'recipient_not_found', detail: String(e).slice(0, 200) })
    throw e
  }
  return JSON.stringify({ sent: true })
}
`

const PROBE_SCRIPT = `
function run(argv) {
  return JSON.stringify({ services: Application('Messages').accounts.serviceType() })
}
`

/** 给测试用(逐个 osacompile 校验语法)。 */
export const MESSAGES_SCRIPTS = { send: SEND_SCRIPT, probe: PROBE_SCRIPT } as const

const isChatId = (to: string) => to.includes(';') || /^chat\d+$/.test(to)

function recipientError(to: string): string | null {
  if (!to) return 'to is required: a phone number (+8613800000000), an email, or a group chat_id from imessage.chats.list'
  return isChatId(to) || EMAIL.test(to) || PHONE.test(to) ? null : `to "${to}" is not a phone number, email or chat_id (Contacts lookup is not available: find the handle with imessage.chats.list)`
}

const strArray = (args: Args, key: string): string[] | undefined =>
  Array.isArray(args[key]) && (args[key] as unknown[]).every((v) => typeof v === 'string') ? (args[key] as string[]).map((v) => v.trim()) : undefined
const preview = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text)
const fileNames = (list: string[]) => list.map((f) => path.basename(f)).join('、')

/** 发送的文件:必须在连上了的文件位置里;「信息」读不到的位置先拷进「图片」(10 分钟后清)。 */
async function prepareFiles(raw: string[], ctx: FamilyContext): Promise<{ ok: true; paths: string[]; copied: number } | { ok: false; outcome: Outcome }> {
  if (raw.length === 0) return { ok: true, paths: [], copied: 0 }
  const granted = ctx.granted()
  if (!FILE_ROOTS.some((r) => granted.has(r))) {
    return { ok: false, outcome: fail('not_granted', 'Sending files needs a file location connected on this computer: open 咕咕 → Settings → Devices → What this computer can do, and connect the location that holds the file (Desktop / Documents / Downloads / Other locations).') }
  }
  const home = await fsp.realpath(ctx.deps.homedir()).catch(() => ctx.deps.homedir())
  const pictures = path.join(home, 'Pictures')
  const readable = [pictures, path.join(home, 'Downloads'), path.join(home, 'Documents')]
  const resolved: string[] = []
  for (const item of raw) {
    const r = await resolveInsideRoots(item, granted)
    if (!r.ok) return { ok: false, outcome: bad(`file ${r.message}`) }
    const stat = await fsp.stat(r.path)
    if (!stat.isFile()) return { ok: false, outcome: bad(`${item} is not a file`) }
    resolved.push(r.path)
  }
  await fsp.mkdir(pictures, { recursive: true })
  // 清掉上几次拷的(Messages 早传完了)。
  const now = ctx.deps.now().getTime()
  for (const name of await fsp.readdir(pictures).catch(() => [] as string[])) {
    if (!name.startsWith(SEND_COPY_PREFIX)) continue
    const file = path.join(pictures, name)
    const stat = await fsp.stat(file).catch(() => null)
    if (stat?.isFile() && now - stat.mtimeMs > SEND_COPY_KEEP_MS) await fsp.rm(file, { force: true })
  }
  let copied = 0
  const paths: string[] = []
  for (const real of resolved) {
    if (readable.some((dir) => real.startsWith(dir + path.sep))) {
      paths.push(real)
      continue
    }
    const copy = path.join(pictures, `${SEND_COPY_PREFIX}${randomUUID().slice(0, 8)}_${path.basename(real)}`)
    await fsp.copyFile(real, copy)
    const at = new Date(now)
    await fsp.utimes(copy, at, at)
    paths.push(copy)
    copied += 1
  }
  return { ok: true, paths, copied }
}

interface SentRow { id: number; error: number | null; is_sent: number; is_delivered: number; service: string | null }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

async function send(args: Args, ctx: FamilyContext, text: string, rawFiles: string[]): Promise<Outcome> {
  const to = str(args, 'to')
  const files = await prepareFiles(rawFiles, ctx)
  if (!files.ok) return files.outcome
  return withDb(async () => {
    let chatId: string | undefined
    if (to.includes(';')) chatId = to
    else if (/^chat\d+$/.test(to)) {
      const rows = await query<{ guid: string }>(ctx, `SELECT guid FROM chat WHERE chat_identifier = ${sqlText(to)} LIMIT 1`)
      if (!rows[0]) return bad(`No group chat ${to}: get chat_id from imessage.chats.list.`)
      chatId = rows[0].guid
    }
    await launchHidden(ctx)
    const startNs = appleNanos(ctx.deps.now().getTime() - 2000)
    ctx.note(`正在用「信息」发给 ${to}…`)
    const value = await ctx.deps.jxa(SEND_SCRIPT, { to, chatId, text, files: files.paths }, { app: APP, signal: ctx.signal, timeoutMs: 120_000 })
    const r = (value && typeof value === 'object' ? value : {}) as { sent?: boolean; error?: string; detail?: string }
    if (r.error === 'no_imessage_account') return fail('execution_failed', 'Messages on this Mac is not signed in to iMessage (or the account is turned off): sign in under Messages → Settings → iMessage, then retry.')
    if (r.error === 'chat_not_found') return bad(`Messages has no chat ${to}: get chat_id from imessage.chats.list.`)
    if (r.error === 'recipient_not_found') return fail('execution_failed', `Messages could not address ${to} over iMessage (${r.detail ?? 'unknown recipient'}). Nothing was sent.`)
    if (r.sent !== true) throw new Error('the Messages script returned nothing')
    // 「信息」接了就回,投没投出去要看 chat.db:对方没开 iMessage 时那条会带 error(界面上是红色的「未送达」)。
    const expected = (text ? 1 : 0) + files.paths.length
    const match = chatId ? `c.guid = ${sqlText(chatId)}` : handleMatch('c.chat_identifier', to)
    let rows: SentRow[] = []
    // 已经发出去了:这里读不了库只能说「没核实」,❌ 报成失败(agent 会再发一遍)。
    let unchecked: string | null = null
    for (let attempt = 0; attempt < SEND_CHECK_TRIES; attempt += 1) {
      await sleep(SEND_CHECK_DELAY_MS, ctx.signal)
      try {
        rows = await query<SentRow>(ctx, `SELECT m.ROWID AS id, m.error, m.is_sent, m.is_delivered, m.service FROM message m
JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
WHERE m.is_from_me = 1 AND ${DATE_NS} >= ${startNs} AND ${match} ORDER BY m.date DESC LIMIT ${expected + 5}`)
      } catch (error) {
        if (!(error instanceof MessagesDbError)) throw error
        unchecked = error.message
        break
      }
      if (rows.some((row) => row.error)) break
      if (rows.length >= expected && rows.every((row) => row.is_sent === 1 || row.is_delivered === 1)) break
    }
    const failed = rows.find((row) => row.error)
    if (failed) {
      return fail('execution_failed', `Messages could not deliver to ${to} (error ${failed.error}): the recipient is probably not reachable over iMessage. It shows as "Not Delivered" in Messages on this Mac; nothing more was sent.`)
    }
    const status = rows.length < expected ? 'unconfirmed' : rows.every((row) => row.is_delivered === 1) ? 'delivered' : rows.every((row) => row.is_sent === 1 || row.is_delivered === 1) ? 'sent' : 'sending'
    return ok({
      to,
      status,
      sent_at: localIso(ctx.deps.now()),
      text: text ? preview(text, 200) : null,
      files: rawFiles.map((f) => path.basename(f)),
      ...(status === 'unconfirmed'
        ? { note: unchecked ? `Messages accepted it, but delivery could not be checked (${unchecked}). Do not send it again.` : 'Messages accepted it but the message has not shown up in its history yet; check later with imessage.conversation.get. Do not send it again.' }
        : {}),
    })
  })
}

// ---------- 动作 ----------

const sinceWhere = (args: Args): string | null => {
  const since = str(args, 'since')
  return since ? `${DATE_NS} >= ${appleNanos(Date.parse(since))}` : null
}
const sinceError = (args: Args) => (str(args, 'since') && !isDate(str(args, 'since')) ? 'since must be an ISO 8601 date-time' : null)
const CONFIRMED = { [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'true only after the person approved the question returned by needs_confirmation.' } }
const TO = { type: 'string', description: 'A phone number (+8613800000000), an email, or a group chat_id from imessage.chats.list.' }

export function createMessagesFamily(): ActionFamily {
  const actions: ActionDef[] = [
    {
      name: 'imessage.chats.list',
      group: 'messages',
      title: '列信息会话',
      titleEn: 'List message chats',
      description: 'List iMessage / SMS / RCS chats on this Mac, most recent first: chat_id (pass it as `to` to message a group), name (group name, if set), identifier, service, is_group, participants (raw phone numbers / emails — no contact names here), last_message_at, unread. type filters group / dm; search matches the group name, identifier or a participant; hasUnread keeps chats with unread messages. Default 50, max 200.',
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['all', 'group', 'dm'] },
          hasUnread: { type: 'boolean' },
          sortBy: { type: 'string', enum: ['recent', 'name'] },
          search: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      validate: (args) => (args.type !== undefined && !['all', 'group', 'dm'].includes(str(args, 'type')) ? 'type must be all, group or dm' : null),
      run: (args, ctx) => withDb(async () => {
        const where: string[] = []
        const groupExpr = '(c.style = 43 OR (SELECT COUNT(*) FROM chat_handle_join x WHERE x.chat_id = c.ROWID) > 1)'
        if (str(args, 'type') === 'group') where.push(groupExpr)
        if (str(args, 'type') === 'dm') where.push(`NOT ${groupExpr}`)
        if (bool(args, 'hasUnread')) where.push('COALESCE(u.n, 0) > 0')
        const search = str(args, 'search')
        if (search) {
          const like = sqlContains(search)
          where.push(`(c.display_name LIKE ${like} OR c.chat_identifier LIKE ${like} OR EXISTS (SELECT 1 FROM chat_handle_join x JOIN handle h ON h.ROWID = x.handle_id WHERE x.chat_id = c.ROWID AND h.id LIKE ${like}))`)
        }
        const rows = await query<ChatRow>(ctx, chatSql(where, str(args, 'sortBy') === 'name' ? 'name' : 'recent', clampInt(num(args, 'limit'), 50, 1, 200)))
        return ok({ total: rows.length, chats: rows.map(chatOut) })
      }),
    },
    {
      name: 'imessage.conversation.get',
      group: 'messages',
      title: '读信息对话',
      titleEn: 'Read conversation',
      description: 'Read the conversation with someone: contact = phone number, email, chat_id / identifier from imessage.chats.list, or a group name. Returns up to 5 matching chats (e.g. the same person over iMessage and SMS), each with its latest messages oldest-first (limit per chat, default 20, max 200; since keeps only newer ones). Messages: time, from_me, sender, text, reaction, attachments (name, type, size, local path). There is no Contacts lookup here — a person\'s name only matches a named group.',
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        required: ['contact'],
        properties: {
          contact: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          since: { type: 'string', description: `Only messages at or after this time. ${TIME_HINT}` },
        },
        additionalProperties: false,
      },
      validate: (args) => (str(args, 'contact') ? sinceError(args) : 'contact is required'),
      run: (args, ctx) => withDb(async () => {
        const contact = str(args, 'contact')
        const byHandle = contact.includes(';') || EMAIL.test(contact) || PHONE.test(contact) || /^chat\d+$/.test(contact)
        const chats = await query<ChatRow>(ctx, chatSql([byHandle ? chatMatch(contact) : `c.display_name LIKE ${sqlContains(contact)}`], 'recent', 5))
        if (chats.length === 0) {
          return bad(`No chat matches "${contact}". ${byHandle ? 'Check the number / email with imessage.chats.list.' : 'Contacts lookup is not available here: pass a phone number or email, or find the chat with imessage.chats.list (search).'}`)
        }
        const limit = clampInt(num(args, 'limit'), 20, 1, 200)
        const since = sinceWhere(args)
        const conversations = []
        for (const chat of chats) {
          const messages = await loadMessages(ctx, [`j.chat_id = ${Number(chat.rowid)}`, ...(since ? [since] : [])], limit, false)
          conversations.push({ chat: chatOut(chat), messages: messages.reverse() })
        }
        return ok({ conversations })
      }),
    },
    {
      name: 'imessage.search',
      group: 'messages',
      title: '搜信息',
      titleEn: 'Search messages',
      description: 'Search messages, newest first. Filters (all optional, combined): search (text contains), sender (phone / email), chatId (from imessage.chats.list), since, unreadOnly, excludeOwnMessages, service (iMessage / SMS / RCS), hasAttachments, excludeReactions. Each message carries chat_id / chat_name. Default 50, max 200.',
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Text the message contains (case-insensitive for Latin letters).' },
          sender: { type: 'string', description: 'Sender phone number or email.' },
          chatId: { type: 'string' },
          since: { type: 'string', description: `Only messages at or after this time. ${TIME_HINT}` },
          unreadOnly: { type: 'boolean' },
          excludeOwnMessages: { type: 'boolean' },
          service: { type: 'string', enum: ['iMessage', 'SMS', 'RCS'] },
          hasAttachments: { type: 'boolean' },
          excludeReactions: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      validate: (args) => sinceError(args) ?? (args.service !== undefined && !['iMessage', 'SMS', 'RCS'].includes(str(args, 'service')) ? 'service must be iMessage, SMS or RCS' : null),
      run: (args, ctx) => withDb(async () => {
        const where: string[] = []
        const search = str(args, 'search')
        if (search) where.push(`(m.text LIKE ${sqlContains(search)} OR instr(m.attributedBody, ${sqlHex(search)}) > 0)`)
        const sender = str(args, 'sender')
        if (sender) where.push(`m.is_from_me = 0 AND ${handleMatch('h.id', sender)}`)
        const chatId = str(args, 'chatId')
        if (chatId) where.push(chatMatch(chatId))
        const since = sinceWhere(args)
        if (since) where.push(since)
        if (bool(args, 'unreadOnly')) where.push('m.is_read = 0 AND m.is_from_me = 0')
        if (bool(args, 'excludeOwnMessages')) where.push('m.is_from_me = 0')
        if (str(args, 'service')) where.push(`m.service = ${sqlText(str(args, 'service'))}`)
        if (bool(args, 'hasAttachments')) where.push('m.cache_has_attachments = 1')
        if (bool(args, 'excludeReactions')) where.push('COALESCE(m.associated_message_type, 0) = 0')
        const messages = await loadMessages(ctx, where, clampInt(num(args, 'limit'), 50, 1, 200), true)
        return ok({ total: messages.length, messages })
      }),
    },
    {
      name: 'imessage.unread',
      group: 'messages',
      title: '看未读信息',
      titleEn: 'Unread messages',
      description: 'Unread incoming messages, newest first, grouped by sender (raw phone number / email): {sender, messages}. total / sender_count describe only what is returned (limit default 50, max 200); truncated is true when more unread messages exist.',
      risk: 'medium',
      confirm: 'never',
      input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
      run: (args, ctx) => withDb(async () => {
        const limit = clampInt(num(args, 'limit'), 50, 1, 200)
        const rows = await loadMessages(ctx, ['m.is_read = 0', 'm.is_from_me = 0'], limit + 1, true)
        const messages = rows.slice(0, limit)
        const groups = new Map<string, MessageOut[]>()
        for (const m of messages) groups.set(m.sender, [...(groups.get(m.sender) ?? []), m])
        return ok({ total: messages.length, sender_count: groups.size, truncated: rows.length > limit, groups: [...groups].map(([sender, list]) => ({ sender, messages: list })) })
      }),
    },
    {
      name: 'imessage.send',
      group: 'messages',
      title: '发 iMessage',
      titleEn: 'Send iMessage',
      description: 'Send an iMessage from this Mac to a phone number / email, or to a group (to = chat_id from imessage.chats.list). text is the message; files (optional) are absolute paths inside a connected file location, sent after the text. Always comes back first as needs_confirmation naming the recipient and text — show it to the person, then call again with confirmed: true. After sending it checks Messages\' history: status sent / delivered, or an error if the recipient is not reachable over iMessage.',
      risk: 'high',
      confirm: 'always',
      input_schema: {
        type: 'object',
        required: ['to'],
        properties: { to: TO, text: { type: 'string' }, files: { type: 'array', maxItems: 20, items: { type: 'string' } }, ...CONFIRMED },
        additionalProperties: false,
      },
      validate(args) {
        const problem = recipientError(str(args, 'to'))
        if (problem) return problem
        if (args.files !== undefined && (!strArray(args, 'files') || strArray(args, 'files')!.length > 20)) return 'files must be an array of at most 20 file paths'
        return str(args, 'text') || (strArray(args, 'files') ?? []).length ? null : 'give text (and/or files)'
      },
      question(args) {
        const files = strArray(args, 'files') ?? []
        const text = str(args, 'text')
        return `要给 ${str(args, 'to')} 发 iMessage${text ? `「${preview(text)}」` : ''}${files.length ? `${text ? '并' : ''}附上文件 ${fileNames(files)}` : ''}吗？`
      },
      run: (args, ctx) => send(args, ctx, str(args, 'text'), strArray(args, 'files') ?? []),
    },
    {
      name: 'imessage.send_file',
      group: 'messages',
      title: '用 iMessage 发文件',
      titleEn: 'Send file by iMessage',
      description: 'Send files (any type: PDF, images, documents …) by iMessage to a phone number / email or a group chat_id, with an optional text. paths are absolute paths inside a connected file location. Always comes back first as needs_confirmation naming the recipient and the files — show it to the person, then call again with confirmed: true.',
      risk: 'high',
      confirm: 'always',
      input_schema: {
        type: 'object',
        required: ['to', 'paths'],
        properties: { to: TO, paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } }, text: { type: 'string' }, ...CONFIRMED },
        additionalProperties: false,
      },
      validate(args) {
        const problem = recipientError(str(args, 'to'))
        if (problem) return problem
        const paths = strArray(args, 'paths')
        return paths && paths.length >= 1 && paths.length <= 20 && paths.every(Boolean) ? null : 'paths must be 1-20 file paths'
      },
      question(args) {
        const text = str(args, 'text')
        return `要通过 iMessage 给 ${str(args, 'to')} 发送文件 ${fileNames(strArray(args, 'paths') ?? [])} 吗？${text ? `附言「${preview(text)}」` : ''}`
      },
      run: (args, ctx) => send(args, ctx, str(args, 'text'), strArray(args, 'paths') ?? []),
    },
  ]

  return {
    groups: [{
      id: 'messages',
      platforms: ['darwin'],
      iconApp: '/System/Applications/Messages.app',
      settingsUrl: MAC_PRIVACY('Privacy_AllFiles'),
      osPermission: '系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 打开咕咕；发信息还要 自动化 → 咕咕 → 打开「信息」',
      /** 读要完全磁盘访问权限、发要自动化:两样都碰一下,都通了才算连上。 */
      probe: (ctx) => withDb(async () => {
        await query(ctx, 'SELECT COUNT(*) AS n FROM chat')
        await launchHidden(ctx)
        await ctx.deps.jxa(PROBE_SCRIPT, {}, { app: APP, signal: ctx.signal, timeoutMs: 170_000 })
        return ok(null)
      }),
    }],
    actions,
  }
}
