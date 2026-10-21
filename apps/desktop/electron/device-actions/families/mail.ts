/**
 * 邮件(mail.* 12 个):JXA 驱动「邮件」App(macOS 自动化权限 → 邮件)。
 * 读列表一律走「整列取」(`messages.id()` 一个 Apple Event 拿回整列),❌ 逐封取属性 —— 收件箱上万封时逐封要几分钟;
 * 只给最新的前 limit 封(默认 25,最多 200)。正文只在 get / contentPreview 里读(IMAP 没下载的正文会很慢,预览用短超时)。
 * 发出去的(发信 / 回复 / 转发)、删掉的都先问人;问句写清「用哪个地址、发给谁、什么主题」「删的是哪几封」。
 * 发信只存草稿(sendImmediately: false)不出这台电脑,不用问 —— 所以 mail.send 的确认在 run 里自己判(confirm = on_conflict)。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import {
  bad,
  bool,
  clampInt,
  fail,
  isDate,
  MAC_PRIVACY,
  num,
  ok,
  str,
  TIME_HINT,
  type ActionDef,
  type ActionFamily,
  type Args,
  type FamilyContext,
  type Outcome,
} from '../catalog'
import { FILE_ROOTS, resolveInsideRoots } from '../paths'

const APP = '邮件'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200
/** 不给 since 时只看最近 30 天(没有时间窗的「列收件箱」在几万封的邮箱上太慢)。 */
const DEFAULT_WINDOW_DAYS = 30
const PREVIEW_DEFAULT_CHARS = 1200
const PREVIEW_MAX_TIMEOUT_MS = 8000

/**
 * 各脚本共用的 JXA 片段。`soft` 读一个可能读不到的属性;但「系统不让发 Apple Event」(-1743)/「等授权没应答」(-1712)
 * 必须原样抛出去,runJxa 才能把它认成系统权限 —— ❌ 在脚本里吞掉所有异常(那样没授权会被报成「没找到」)。
 */
const MAIL_LIB = `
function iso(d) {
  if (!d) return null
  const t = new Date(d)
  if (isNaN(t.getTime())) return null
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0')
  const off = -t.getTimezoneOffset()
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + 'T' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + (off >= 0 ? '+' : '-') + pad(off / 60) + ':' + pad(off % 60)
}
function soft(f, fallback) {
  try {
    const v = f()
    return v === undefined || v === null ? fallback : v
  } catch (e) {
    if (e && (e.errorNumber === -1743 || e.errorNumber === -1712)) throw e
    return fallback
  }
}
function mailboxTree(container, prefix, out, seen) {
  const list = soft(() => container.mailboxes(), [])
  if (!list.length) return out
  const names = soft(() => container.mailboxes.name(), [])
  const unread = soft(() => container.mailboxes.unreadCount(), [])
  for (let i = 0; i < list.length; i++) {
    const p = prefix ? prefix + '/' + names[i] : String(names[i])
    if (seen[p]) continue
    seen[p] = true
    out.push({ mb: list[i], name: names[i], path: p, unread: unread[i] || 0 })
    if (soft(() => list[i].mailboxes.length, 0) > 0) mailboxTree(list[i], p, out, seen)
  }
  return out
}
function accountsOf(app, accountId) {
  return accountId ? app.accounts.whose({ id: accountId })() : app.accounts()
}
function findMailbox(app, name, accountId) {
  for (const acc of accountsOf(app, accountId)) {
    for (const e of mailboxTree(acc, '', [], {})) if (e.name === name || e.path === name) return e.mb
  }
  if (!accountId) for (const e of mailboxTree(app, '', [], {})) if (e.name === name || e.path === name) return e.mb
  return null
}
function mailboxNames(app, accountId) {
  const out = []
  for (const acc of accountsOf(app, accountId)) for (const e of mailboxTree(acc, '', [], {})) if (out.indexOf(e.path) < 0) out.push(e.path)
  return out.slice(0, 60)
}
function findMessage(app, id, hint) {
  const look = (mb) => {
    const spec = mb.messages.whose({ id: id })
    return soft(() => spec.id().length, 0) > 0 ? spec()[0] : null
  }
  if (hint && hint.mailbox) {
    const box = findMailbox(app, hint.mailbox, hint.accountId)
    const m = box ? look(box) : null
    if (m) return m
  }
  const inInbox = look(app.inbox())
  if (inInbox) return inInbox
  for (const acc of app.accounts()) for (const e of mailboxTree(acc, '', [], {})) { const m = look(e.mb); if (m) return m }
  for (const e of mailboxTree(app, '', [], {})) { const m = look(e.mb); if (m) return m }
  return null
}
function sameIds(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
`

const ACCOUNTS_SCRIPT = `
function run(argv) {
  const app = Application('Mail')
  const accts = app.accounts
  const ids = accts.id()
  const names = accts.name()
  const enabled = soft(() => accts.enabled(), [])
  const emails = soft(() => accts.emailAddresses(), [])
  const types = soft(() => accts.accountType(), [])
  const users = soft(() => accts.userName(), [])
  return JSON.stringify({ accounts: ids.map((id, i) => ({ id: id, name: names[i], type: String(types[i] || 'unknown'), enabled: enabled[i] !== false, emails: emails[i] || [], user_name: users[i] || null })) })
}
`

const MAILBOXES_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const accts = accountsOf(app, p.accountId)
  if (p.accountId && !accts.length) return JSON.stringify({ error: 'account_not_found' })
  const out = []
  for (const acc of accts) {
    const accId = acc.id()
    const accName = acc.name()
    for (const e of mailboxTree(acc, '', [], {})) out.push({ name: e.name, path: e.path, unread: e.unread, account_id: accId, account: accName })
  }
  if (!p.accountId) for (const e of mailboxTree(app, '', [], {})) out.push({ name: e.name, path: e.path, unread: e.unread, account_id: null, account: 'On My Mac' })
  return JSON.stringify({ total: out.length, mailboxes: out.slice(0, 500) })
}
`

/**
 * 列 / 搜邮件(只读元数据):先整列取 id + 收信时间(+ 要过滤的列),筛完按时间倒序取前 limit 封,再读这几封的属性。
 * 邮箱超过 2 万封时先让「邮件」按时间窗筛(whose),❌ 整列拉几万行。两次读到的 id 列不一样 = 读的时候来了新信,重读一次。
 */
const LIST_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  let scope = null
  let boxName = null
  let accountFilter = null
  if (p.mailbox) {
    const box = findMailbox(app, p.mailbox, p.accountId)
    if (!box) return JSON.stringify({ error: 'mailbox_not_found', available: mailboxNames(app, p.accountId) })
    scope = box.messages
    boxName = soft(() => box.name(), p.mailbox)
  } else if (p.accountId) {
    const accs = app.accounts.whose({ id: p.accountId })()
    if (!accs.length) return JSON.stringify({ error: 'account_not_found' })
    let box = null
    for (const n of ['INBOX', 'Inbox']) {
      const found = soft(() => accs[0].mailboxes.whose({ name: n })(), [])
      if (found.length) { box = found[0]; break }
    }
    if (box) { scope = box.messages; boxName = soft(() => box.name(), null) } else { scope = app.inbox().messages; accountFilter = String(p.accountId) }
  } else {
    scope = app.inbox().messages
  }
  const sinceMs = p.since ? Date.parse(p.since) : NaN
  const count = scope.length
  const spec = count > 20000 && !isNaN(sinceMs) ? scope.whose({ dateReceived: { _greaterThan: new Date(sinceMs) } }) : scope
  let cols = null
  for (let attempt = 0; attempt < 2 && !cols; attempt++) {
    const ids = spec.id()
    const c = {
      ids: ids,
      dates: spec.dateReceived(),
      read: p.unreadOnly ? spec.readStatus() : null,
      subjects: p.subject ? spec.subject() : null,
      senders: p.sender ? spec.sender() : null,
      accounts: accountFilter ? spec.mailbox.account.id() : null,
    }
    if (sameIds(ids, spec.id())) cols = c
  }
  if (!cols) return JSON.stringify({ error: 'mailbox_changed' })
  const subj = p.subject ? String(p.subject).toLowerCase() : null
  const snd = p.sender ? String(p.sender).toLowerCase() : null
  const ms = cols.dates.map((d) => { const t = d ? new Date(d).getTime() : 0; return isNaN(t) ? 0 : t })
  const hits = []
  for (let i = 0; i < cols.ids.length; i++) {
    if (!isNaN(sinceMs) && !(ms[i] > sinceMs)) continue
    if (cols.read && cols.read[i] !== false) continue
    if (subj && String(cols.subjects[i] || '').toLowerCase().indexOf(subj) < 0) continue
    if (snd && String(cols.senders[i] || '').toLowerCase().indexOf(snd) < 0) continue
    if (cols.accounts && String(cols.accounts[i]) !== accountFilter) continue
    hits.push(i)
  }
  hits.sort((a, b) => ms[b] - ms[a])
  const picked = hits.slice(0, p.limit)
  let batch = null
  if (picked.length && cols.ids.length <= picked.length * 50) {
    const b = {
      subject: spec.subject(), sender: spec.sender(), read: spec.readStatus(), flagged: spec.flaggedStatus(),
      mailbox: boxName ? null : soft(() => spec.mailbox.name(), null),
      account: soft(() => spec.mailbox.account.id(), null),
    }
    if (sameIds(cols.ids, spec.id())) batch = b
  }
  const rows = []
  for (const i of picked) {
    const m = scope.byId(cols.ids[i])
    const row = batch
      ? { subject: batch.subject[i], sender: batch.sender[i], read: batch.read[i], flagged: batch.flagged[i], mailbox: boxName || (batch.mailbox ? batch.mailbox[i] : null), account_id: batch.account ? batch.account[i] : null }
      : { subject: soft(() => m.subject(), ''), sender: soft(() => m.sender(), ''), read: soft(() => m.readStatus(), false), flagged: soft(() => m.flaggedStatus(), false), mailbox: boxName || soft(() => m.mailbox.name(), null), account_id: soft(() => m.mailbox.account.id(), null) }
    rows.push({
      id: cols.ids[i], subject: row.subject || '', sender: row.sender || '', received: iso(cols.dates[i]), read: row.read === true, flagged: row.flagged === true,
      mailbox: row.mailbox, account_id: row.account_id, has_attachments: soft(() => m.mailAttachments.length, 0) > 0,
    })
  }
  return JSON.stringify({ total_matched: hits.length, messages: rows })
}
`

const GET_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const m = findMessage(app, p.messageId, p)
  if (!m) return JSON.stringify({ error: 'not_found' })
  const people = (list) => {
    const a = soft(() => list.address(), [])
    const n = soft(() => list.name(), [])
    return a.map((x, i) => (n[i] ? n[i] + ' <' + x + '>' : x))
  }
  const att = m.mailAttachments
  const attNames = soft(() => att.name(), [])
  const attTypes = soft(() => att.MIMEType(), [])
  const attSizes = soft(() => att.fileSize(), [])
  const attDone = soft(() => att.downloaded(), [])
  const raw = soft(() => m.content(), null)
  const text = raw === null ? null : String(raw)
  return JSON.stringify({
    message: {
      id: m.id(), message_id: soft(() => m.messageId(), null), subject: soft(() => m.subject(), ''), sender: soft(() => m.sender(), ''),
      reply_to: soft(() => m.replyTo(), null), to: people(m.toRecipients), cc: people(m.ccRecipients), bcc: people(m.bccRecipients),
      sent: iso(soft(() => m.dateSent(), null)), received: iso(soft(() => m.dateReceived(), null)),
      mailbox: soft(() => m.mailbox.name(), null), account_id: soft(() => m.mailbox.account.id(), null),
      read: soft(() => m.readStatus(), false), flagged: soft(() => m.flaggedStatus(), false), junk: soft(() => m.junkMailStatus(), false),
      replied: soft(() => m.wasRepliedTo(), false), forwarded: soft(() => m.wasForwarded(), false),
      attachments: attNames.map((n, i) => ({ name: n, mime_type: attTypes[i] || null, size: attSizes[i] || 0, downloaded: attDone[i] === true })),
    },
    content: text === null ? null : text.slice(0, p.maxContentLength),
    content_length: text === null ? 0 : text.length,
  })
}
`

const PREVIEW_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const m = findMessage(app, p.messageId, p)
  if (!m) return JSON.stringify({ error: 'not_found' })
  const raw = soft(() => m.content(), null)
  if (raw === null) return JSON.stringify({ status: 'unavailable', content: null, content_length: 0 })
  const text = String(raw)
  return JSON.stringify({ status: 'ok', content: text.slice(0, p.maxContentLength), content_length: text.length })
}
`

const MARK_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const out = []
  for (const id of p.messageIds) {
    const m = findMessage(app, id, p)
    if (!m) { out.push({ id: id, updated: false, error: 'not found' }); continue }
    try {
      if (p.read !== undefined) m.readStatus = p.read
      if (p.flagged !== undefined) m.flaggedStatus = p.flagged
      if (p.flagIndex !== undefined) m.flagIndex = p.flagIndex
      if (p.junk !== undefined) m.junkMailStatus = p.junk
      out.push({ id: id, updated: true })
    } catch (e) {
      if (e && (e.errorNumber === -1743 || e.errorNumber === -1712)) throw e
      out.push({ id: id, updated: false, error: String(e).slice(0, 200) })
    }
  }
  return JSON.stringify({ results: out })
}
`

const MOVE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  if (p.toAccountId && !app.accounts.whose({ id: p.toAccountId })().length) return JSON.stringify({ error: 'account_not_found' })
  const target = findMailbox(app, p.toMailbox, p.toAccountId)
  if (!target) return JSON.stringify({ error: 'mailbox_not_found', available: mailboxNames(app, p.toAccountId) })
  const out = []
  for (const id of p.messageIds) {
    const m = findMessage(app, id, null)
    if (!m) { out.push({ id: id, moved: false, error: 'not found' }); continue }
    try {
      m.move({ to: target })
      out.push({ id: id, moved: true })
    } catch (e) {
      if (e && (e.errorNumber === -1743 || e.errorNumber === -1712)) throw e
      out.push({ id: id, moved: false, error: String(e).slice(0, 200) })
    }
  }
  return JSON.stringify({ results: out })
}
`

/** 删前逐封核对主题(问人时念的是 agent 给的主题;对不上的那封不删)。「邮件」的删除 = 移到废纸篓。 */
const DELETE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const out = []
  for (let k = 0; k < p.messageIds.length; k++) {
    const id = p.messageIds[k]
    const m = findMessage(app, id, null)
    if (!m) { out.push({ id: id, deleted: false, error: 'not found' }); continue }
    const subject = String(soft(() => m.subject(), ''))
    if (subject.trim() !== String(p.subjects[k]).trim()) { out.push({ id: id, deleted: false, error: 'subject is "' + subject + '", not the one confirmed; left alone' }); continue }
    try {
      app.delete(m)
      out.push({ id: id, deleted: true, subject: subject })
    } catch (e) {
      if (e && (e.errorNumber === -1743 || e.errorNumber === -1712)) throw e
      out.push({ id: id, deleted: false, error: String(e).slice(0, 200) })
    }
  }
  return JSON.stringify({ results: out })
}
`

const SEND_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const props = { subject: p.subject, content: p.content, visible: false }
  if (p.sender) props.sender = p.sender
  app.outgoingMessages.push(app.OutgoingMessage(props))
  const all = app.outgoingMessages()
  const msg = all[all.length - 1]
  for (const a of p.to) msg.toRecipients.push(app.Recipient({ address: a }))
  for (const a of p.cc) msg.ccRecipients.push(app.Recipient({ address: a }))
  for (const a of p.bcc) msg.bccRecipients.push(app.Recipient({ address: a }))
  for (const f of p.attachments) {
    try {
      msg.attachments.push(app.Attachment({ fileName: Path(f) }))
    } catch (e) {
      try { app.delete(msg) } catch (ignored) {}
      if (e && (e.errorNumber === -1743 || e.errorNumber === -1712)) throw e
      return JSON.stringify({ error: 'attach_failed', file: f, detail: String(e).slice(0, 200) })
    }
  }
  if (p.send) msg.send()
  else msg.save()
  return JSON.stringify({ sent: p.send === true, sender: soft(() => msg.sender(), null) })
}
`

/** 回复 / 转发:先核对原信主题(问人时念的就是它),再由「邮件」生成回复 / 转发(带引用原文),附言写在最前面。 */
const REPLY_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Mail')
  const m = findMessage(app, p.messageId, p)
  if (!m) return JSON.stringify({ error: 'not_found' })
  const subject = String(soft(() => m.subject(), ''))
  if (subject.trim() !== String(p.subject).trim()) return JSON.stringify({ error: 'subject_mismatch', subject: subject })
  const nl = String.fromCharCode(10)
  const r = p.forward ? app.forward(m, { openingWindow: false }) : app.reply(m, { openingWindow: false, replyToAll: p.replyAll === true })
  if (!r) return JSON.stringify({ error: 'compose_failed' })
  if (p.forward) for (const a of p.to) r.toRecipients.push(app.Recipient({ address: a }))
  if (p.content) r.content = p.content + nl + nl + String(soft(() => r.content(), ''))
  const to = soft(() => r.toRecipients.address(), [])
  const cc = soft(() => r.ccRecipients.address(), [])
  if (p.send) r.send()
  else r.save()
  return JSON.stringify({ sent: p.send === true, subject: String(soft(() => r.subject(), '')), to: to, cc: cc })
}
`

const PROBE_SCRIPT = `
function run(argv) {
  return JSON.stringify({ accounts: Application('Mail').accounts.name().length })
}
`

/** 给测试用(逐个 osacompile 校验语法)。 */
export const MAIL_SCRIPTS = {
  accounts: ACCOUNTS_SCRIPT, mailboxes: MAILBOXES_SCRIPT, list: LIST_SCRIPT, get: GET_SCRIPT, preview: PREVIEW_SCRIPT, mark: MARK_SCRIPT,
  move: MOVE_SCRIPT, delete: DELETE_SCRIPT, send: SEND_SCRIPT, reply: REPLY_SCRIPT, probe: PROBE_SCRIPT,
} as const
export const MAIL_JXA_LIB = MAIL_LIB

type ScriptResult = Record<string, unknown> & { error?: string }

/** 「邮件」没开着就先在后台隐藏启动,❌ 让 JXA 把它连窗口一起拉起来;开着就不碰(❌ 把人正在用的窗口藏掉)。 */
async function launchHidden(ctx: FamilyContext) {
  const running = await ctx.deps.exec('/usr/bin/pgrep', ['-x', 'Mail'], { signal: ctx.signal, timeoutMs: 5000 })
  if (running.code === 0) return
  await ctx.deps.exec('/usr/bin/open', ['-g', '-j', '-b', 'com.apple.mail'], { signal: ctx.signal, timeoutMs: 15_000 })
}

async function mail(ctx: FamilyContext, script: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; launched?: boolean } = {}): Promise<ScriptResult> {
  if (!options.launched) await launchHidden(ctx)
  const value = await ctx.deps.jxa(MAIL_LIB + script, input, { app: APP, signal: options.signal ?? ctx.signal, timeoutMs: options.timeoutMs ?? 280_000 })
  if (!value || typeof value !== 'object') throw new Error('the Mail script returned nothing')
  return value as ScriptResult
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
const strArray = (args: Args, key: string): string[] | undefined =>
  Array.isArray(args[key]) && (args[key] as unknown[]).every((v) => typeof v === 'string') ? (args[key] as string[]).map((v) => v.trim()) : undefined
const ids = (args: Args): number[] | undefined =>
  Array.isArray(args.messageIds) && (args.messageIds as unknown[]).every((v) => Number.isSafeInteger(v) && (v as number) > 0) ? (args.messageIds as number[]) : undefined
const preview = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text)
const quoteList = (items: string[], max = 5) => items.slice(0, max).map((s) => `「${preview(s || '（无主题）', 30)}」`).join('') + (items.length > max ? ` 等 ${items.length} 封` : '')

function checkRecipients(args: Args, key: string, required: boolean): string | null {
  if (args[key] === undefined) return required ? `${key} is required (an array of email addresses)` : null
  const list = strArray(args, key)
  if (!list) return `${key} must be an array of email addresses`
  if (required && list.length === 0) return `${key} must contain at least one email address`
  if (list.length > 100) return `${key} has more than 100 addresses`
  const badOne = list.find((a) => !EMAIL.test(a))
  return badOne === undefined ? null : `${key}: "${badOne}" is not an email address`
}

function scriptFailure(r: ScriptResult, what: { messageId?: number; mailbox?: string; accountId?: string }): Outcome | null {
  switch (r.error) {
    case undefined:
      return null
    case 'not_found':
      return bad(`No message with id ${what.messageId} in Mail (ids change when a message is moved). Find it again with mail.messages.list / mail.messages.find.`)
    case 'mailbox_not_found':
      return bad(`No mailbox "${what.mailbox}"${what.accountId ? ` in account ${what.accountId}` : ''}. Mailboxes: ${(Array.isArray(r.available) ? r.available : []).join(', ') || 'none'}. (Gmail archives to "All Mail", not "Archive".)`)
    case 'account_not_found':
      return bad(`No Mail account with id ${what.accountId}: get the ids from mail.accounts.list.`)
    case 'mailbox_changed':
      return fail('execution_failed', 'New mail arrived while the mailbox was being read; call again.')
    default:
      return fail('execution_failed', `Mail: ${String(r.error)}`)
  }
}

const LIST_PROPS = {
  mailbox: { type: 'string', description: 'Mailbox name or path from mail.mailboxes.list (e.g. "INBOX", "Sent Messages", "Work/Projects"). Omit for the unified Inbox of all accounts.' },
  accountId: { type: 'string', description: 'Account id from mail.accounts.list. Without mailbox: only that account\'s Inbox.' },
  unreadOnly: { type: 'boolean', description: 'Only unread messages (Mail\'s unread flag can lag for iCloud/Gmail; prefer since).' },
  since: { type: 'string', description: `Only messages received after this time. ${TIME_HINT} Default: the last ${DEFAULT_WINDOW_DAYS} days.` },
  subject: { type: 'string', description: 'Subject contains this text (case-insensitive).' },
  sender: { type: 'string', description: 'Sender (name or address) contains this text (case-insensitive).' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Max messages, newest first (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
}

function validateList(args: Args): string | null {
  const since = str(args, 'since')
  if (since && !isDate(since)) return 'since must be an ISO 8601 date-time'
  for (const key of ['mailbox', 'accountId', 'subject', 'sender']) if (args[key] !== undefined && typeof args[key] !== 'string') return `${key} must be a string`
  return null
}

async function listMessages(args: Args, ctx: FamilyContext, tag: string): Promise<Outcome> {
  const since = str(args, 'since') || new Date(ctx.deps.now().getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString()
  const input = {
    mailbox: str(args, 'mailbox') || undefined,
    accountId: str(args, 'accountId') || undefined,
    unreadOnly: bool(args, 'unreadOnly') === true,
    since: new Date(Date.parse(since)).toISOString(),
    subject: str(args, 'subject') || undefined,
    sender: str(args, 'sender') || undefined,
    limit: clampInt(num(args, 'limit'), DEFAULT_LIMIT, 1, MAX_LIMIT),
  }
  ctx.note(`正在读「邮件」的${input.mailbox ? `「${input.mailbox}」` : '收件箱'}…（${tag}）`)
  const r = await mail(ctx, LIST_SCRIPT, input)
  const failure = scriptFailure(r, input)
  if (failure) return failure
  const messages = Array.isArray(r.messages) ? r.messages : []
  const total = typeof r.total_matched === 'number' ? r.total_matched : messages.length
  return ok({ since: input.since, total_matched: total, returned: messages.length, truncated: total > messages.length, messages })
}

/** 附件路径:必须落在连上了的文件位置里(和读写文件同一套判定),且是文件。 */
async function resolveAttachments(raw: string[], ctx: FamilyContext): Promise<{ ok: true; paths: string[] } | { ok: false; outcome: Outcome }> {
  if (raw.length === 0) return { ok: true, paths: [] }
  const granted = ctx.granted()
  if (!FILE_ROOTS.some((r) => granted.has(r))) {
    return { ok: false, outcome: fail('not_granted', 'Attaching files needs a file location connected on this computer: open 咕咕 → Settings → Devices → What this computer can do, and connect the location that holds the file (Desktop / Documents / Downloads / Other locations).') }
  }
  const paths: string[] = []
  for (const item of raw) {
    const r = await resolveInsideRoots(item, granted)
    if (!r.ok) return { ok: false, outcome: bad(`attachment ${r.message}`) }
    const stat = await fsp.stat(r.path)
    if (!stat.isFile()) return { ok: false, outcome: bad(`attachment ${item} is not a file`) }
    paths.push(r.path)
  }
  return { ok: true, paths }
}

const MESSAGE_ID = { type: 'integer', minimum: 1, description: 'Message id from mail.messages.list / mail.messages.find.' }
const HINT_PROPS = {
  mailbox: { type: 'string', description: 'The message\'s mailbox from the listing (makes the lookup much faster).' },
  accountId: { type: 'string', description: 'The message\'s account_id from the listing (with mailbox).' },
}
const CONFIRMED = { [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'true only after the person approved the question returned by needs_confirmation.' } }

function messageIdError(args: Args): string | null {
  const id = num(args, 'messageId')
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? null : 'messageId must be a positive integer (from mail.messages.list)'
}

export function createMailFamily(): ActionFamily {
  const actions: ActionDef[] = [
    {
      name: 'mail.accounts.list',
      group: 'mail',
      title: '列邮件账户',
      titleEn: 'List mail accounts',
      description: 'List the email accounts set up in this Mac\'s Mail app: id (use as accountId / fromAccountId), name, type, enabled, email addresses.',
      risk: 'low',
      confirm: 'never',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, ctx) {
        const r = await mail(ctx, ACCOUNTS_SCRIPT, {})
        return scriptFailure(r, {}) ?? ok({ accounts: Array.isArray(r.accounts) ? r.accounts : [] })
      },
    },
    {
      name: 'mail.mailboxes.list',
      group: 'mail',
      title: '列邮箱',
      titleEn: 'List mailboxes',
      description: 'List mailboxes (folders) in Mail with their unread counts: name, path (nested folders as "Parent/Child"; use it as mailbox / toMailbox), account_id, account. accountId limits it to one account; without it local "On My Mac" mailboxes are included too.',
      risk: 'low',
      confirm: 'never',
      input_schema: { type: 'object', properties: { accountId: LIST_PROPS.accountId }, additionalProperties: false },
      validate: (args) => (args.accountId !== undefined && typeof args.accountId !== 'string' ? 'accountId must be a string' : null),
      async run(args, ctx) {
        const accountId = str(args, 'accountId') || undefined
        const r = await mail(ctx, MAILBOXES_SCRIPT, { accountId })
        return scriptFailure(r, { accountId }) ?? ok({ total: r.total, mailboxes: Array.isArray(r.mailboxes) ? r.mailboxes : [] })
      },
    },
    {
      name: 'mail.messages.list',
      group: 'mail',
      title: '列邮件',
      titleEn: 'List messages',
      description: `List messages in a mailbox (default: the unified Inbox), newest first, metadata only (never the body): id, subject, sender, received, read, flagged, mailbox, account_id, has_attachments. Defaults to the last ${DEFAULT_WINDOW_DAYS} days (pass since for older mail) and ${DEFAULT_LIMIT} messages (max ${MAX_LIMIT}); total_matched tells how many matched. Read a body with mail.messages.contentPreview.get (quick) or mail.messages.get.`,
      risk: 'medium',
      confirm: 'never',
      input_schema: { type: 'object', properties: LIST_PROPS, additionalProperties: false },
      validate: validateList,
      run: (args, ctx) => listMessages(args, ctx, '列邮件'),
    },
    {
      name: 'mail.messages.find',
      group: 'mail',
      title: '搜邮件',
      titleEn: 'Find messages',
      description: `Search messages by subject / sender / time / unread in a mailbox (default: the unified Inbox); metadata only, newest first. Give at least one of subject, sender, since, unreadOnly. Without since only the last ${DEFAULT_WINDOW_DAYS} days are searched — pass an earlier since to look further back. Same fields as mail.messages.list.`,
      risk: 'medium',
      confirm: 'never',
      input_schema: { type: 'object', properties: LIST_PROPS, additionalProperties: false },
      validate: (args) => validateList(args) ?? (str(args, 'subject') || str(args, 'sender') || str(args, 'since') || bool(args, 'unreadOnly') ? null : 'give at least one of subject, sender, since, unreadOnly (or use mail.messages.list)'),
      run: (args, ctx) => listMessages(args, ctx, '搜邮件'),
    },
    {
      name: 'mail.messages.get',
      group: 'mail',
      title: '读邮件',
      titleEn: 'Read message',
      description: 'Read one message in full: headers (to / cc / bcc / reply_to / dates), flags, attachments (name, type, size) and the plain-text body (up to maxContentLength characters, default 20000; content_length is the full length). May be slow if Mail has not downloaded the body yet — for a quick look use mail.messages.contentPreview.get.',
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        required: ['messageId'],
        properties: { messageId: MESSAGE_ID, ...HINT_PROPS, maxContentLength: { type: 'integer', minimum: 1, maximum: 100_000, description: 'Body characters to return (default 20000, max 100000).' } },
        additionalProperties: false,
      },
      validate: messageIdError,
      async run(args, ctx) {
        const input = { messageId: num(args, 'messageId'), mailbox: str(args, 'mailbox') || undefined, accountId: str(args, 'accountId') || undefined, maxContentLength: clampInt(num(args, 'maxContentLength'), 20_000, 1, 100_000) }
        ctx.note('正在读这封邮件…')
        const r = await mail(ctx, GET_SCRIPT, input)
        const failure = scriptFailure(r, input)
        if (failure) return failure
        const length = typeof r.content_length === 'number' ? r.content_length : 0
        return ok({ ...(r.message as object), content: r.content ?? null, content_length: length, truncated: length > input.maxContentLength })
      },
    },
    {
      name: 'mail.messages.contentPreview.get',
      group: 'mail',
      title: '看邮件正文预览',
      titleEn: 'Preview message body',
      description: `Get the first maxContentLength characters (default ${PREVIEW_DEFAULT_CHARS}) of one message body, with a short wait (timeoutMs, default/max ${PREVIEW_MAX_TIMEOUT_MS}) so a slow IMAP server does not block. content_status: ok / unavailable / timeout (then try mail.messages.get later). Use it on the few messages that need body text after listing.`,
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        required: ['messageId'],
        properties: {
          messageId: MESSAGE_ID,
          ...HINT_PROPS,
          maxContentLength: { type: 'integer', minimum: 1, maximum: 5000, description: `Preview characters (default ${PREVIEW_DEFAULT_CHARS}, max 5000).` },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: PREVIEW_MAX_TIMEOUT_MS, description: `How long to wait for the body (default/max ${PREVIEW_MAX_TIMEOUT_MS} ms).` },
        },
        additionalProperties: false,
      },
      validate: messageIdError,
      async run(args, ctx) {
        const input = { messageId: num(args, 'messageId'), mailbox: str(args, 'mailbox') || undefined, accountId: str(args, 'accountId') || undefined, maxContentLength: clampInt(num(args, 'maxContentLength'), PREVIEW_DEFAULT_CHARS, 1, 5000) }
        const timeoutMs = clampInt(num(args, 'timeoutMs'), PREVIEW_MAX_TIMEOUT_MS, 1000, PREVIEW_MAX_TIMEOUT_MS)
        await launchHidden(ctx)
        // 自己的短超时:到点就停掉 osascript,回 timeout(❌ 等满整个调用的超时)。
        const local = new AbortController()
        const stop = () => local.abort()
        ctx.signal.addEventListener('abort', stop, { once: true })
        const timer = setTimeout(stop, timeoutMs)
        let r: ScriptResult
        try {
          r = await mail(ctx, PREVIEW_SCRIPT, input, { signal: local.signal, timeoutMs: timeoutMs + 5000, launched: true })
        } catch (error) {
          if (local.signal.aborted && !ctx.signal.aborted) {
            return ok({ id: input.messageId, content_status: 'timeout', content: null, note: `Mail did not return the body within ${timeoutMs / 1000} s (slow server or body not downloaded yet); try mail.messages.get later.` })
          }
          throw error
        } finally {
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', stop)
        }
        const failure = scriptFailure(r, input)
        if (failure) return failure
        const length = typeof r.content_length === 'number' ? r.content_length : 0
        return ok({ id: input.messageId, content_status: r.status === 'ok' ? 'ok' : 'unavailable', content: r.content ?? null, content_length: length, truncated: length > input.maxContentLength })
      },
    },
    {
      name: 'mail.messages.mark',
      group: 'mail',
      title: '标记邮件',
      titleEn: 'Mark messages',
      description: 'Mark messages as read / unread, flagged / unflagged (flagIndex 0-6 picks the flag color, -1 clears it) or junk / not junk. Give messageIds and at least one of read, flagged, flagIndex, junk. Returns a per-message result.',
      risk: 'low',
      confirm: 'never',
      input_schema: {
        type: 'object',
        required: ['messageIds'],
        properties: {
          messageIds: { type: 'array', minItems: 1, maxItems: MAX_LIMIT, items: { type: 'integer', minimum: 1 }, description: 'Message ids from mail.messages.list.' },
          ...HINT_PROPS,
          read: { type: 'boolean' },
          flagged: { type: 'boolean' },
          flagIndex: { type: 'integer', minimum: -1, maximum: 6 },
          junk: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      validate(args) {
        const list = ids(args)
        if (!list || list.length === 0 || list.length > MAX_LIMIT) return `messageIds must be 1-${MAX_LIMIT} positive integers`
        const flagIndex = num(args, 'flagIndex')
        if (args.flagIndex !== undefined && (flagIndex === undefined || !Number.isInteger(flagIndex) || flagIndex < -1 || flagIndex > 6)) return 'flagIndex must be an integer from -1 to 6'
        return ['read', 'flagged', 'junk'].some((k) => bool(args, k) !== undefined) || flagIndex !== undefined ? null : 'give at least one of read, flagged, flagIndex, junk'
      },
      async run(args, ctx) {
        const r = await mail(ctx, MARK_SCRIPT, {
          messageIds: ids(args), mailbox: str(args, 'mailbox') || undefined, accountId: str(args, 'accountId') || undefined,
          read: bool(args, 'read'), flagged: bool(args, 'flagged'), flagIndex: num(args, 'flagIndex'), junk: bool(args, 'junk'),
        })
        const results = Array.isArray(r.results) ? (r.results as Array<{ updated?: boolean }>) : []
        return scriptFailure(r, {}) ?? ok({ updated: results.filter((x) => x.updated).length, total: results.length, results })
      },
    },
    {
      name: 'mail.messages.move',
      group: 'mail',
      title: '移动邮件',
      titleEn: 'Move messages',
      description: 'Move messages to another mailbox (toMailbox = name or path from mail.mailboxes.list; toAccountId picks the account when several have that name). Message ids change after a move — list again before acting on them. Gmail archives to "All Mail".',
      risk: 'medium',
      confirm: 'never',
      input_schema: {
        type: 'object',
        required: ['messageIds', 'toMailbox'],
        properties: {
          messageIds: { type: 'array', minItems: 1, maxItems: MAX_LIMIT, items: { type: 'integer', minimum: 1 } },
          toMailbox: { type: 'string' },
          toAccountId: { type: 'string' },
        },
        additionalProperties: false,
      },
      validate: (args) => {
        const list = ids(args)
        if (!list || list.length === 0 || list.length > MAX_LIMIT) return `messageIds must be 1-${MAX_LIMIT} positive integers`
        return str(args, 'toMailbox') ? null : 'toMailbox is required'
      },
      async run(args, ctx) {
        const input = { messageIds: ids(args), toMailbox: str(args, 'toMailbox'), toAccountId: str(args, 'toAccountId') || undefined }
        const r = await mail(ctx, MOVE_SCRIPT, input)
        const failure = scriptFailure(r, { mailbox: input.toMailbox, accountId: input.toAccountId })
        if (failure) return failure
        const results = Array.isArray(r.results) ? (r.results as Array<{ moved?: boolean }>) : []
        return ok({ moved: results.filter((x) => x.moved).length, total: results.length, results, note: 'Moved messages get new ids.' })
      },
    },
    {
      name: 'mail.messages.delete',
      group: 'mail',
      title: '删邮件',
      titleEn: 'Delete messages',
      description: 'Delete messages (Mail moves them to the Trash). Give messageIds and, in the same order, their subjects exactly as mail.messages.list returned them: the person is asked to approve with those subjects (needs_confirmation → call again with confirmed: true), and a message whose current subject differs is left alone.',
      risk: 'high',
      confirm: 'always',
      input_schema: {
        type: 'object',
        required: ['messageIds', 'subjects'],
        properties: {
          messageIds: { type: 'array', minItems: 1, maxItems: MAX_LIMIT, items: { type: 'integer', minimum: 1 } },
          subjects: { type: 'array', items: { type: 'string' }, description: 'Subject of each message, same order as messageIds.' },
          ...CONFIRMED,
        },
        additionalProperties: false,
      },
      validate(args) {
        const list = ids(args)
        if (!list || list.length === 0 || list.length > MAX_LIMIT) return `messageIds must be 1-${MAX_LIMIT} positive integers`
        const subjects = strArray(args, 'subjects')
        return subjects && subjects.length === list.length ? null : 'subjects must list the subject of every message, in the same order as messageIds'
      },
      question: (args) => `要把这 ${ids(args)?.length ?? 0} 封邮件移到废纸篓吗？${quoteList(strArray(args, 'subjects') ?? [])}`,
      async run(args, ctx) {
        const r = await mail(ctx, DELETE_SCRIPT, { messageIds: ids(args), subjects: strArray(args, 'subjects') })
        const failure = scriptFailure(r, {})
        if (failure) return failure
        const results = Array.isArray(r.results) ? (r.results as Array<{ deleted?: boolean }>) : []
        return ok({ deleted: results.filter((x) => x.deleted).length, total: results.length, results })
      },
    },
    {
      name: 'mail.send',
      group: 'mail',
      title: '发邮件',
      titleEn: 'Send email',
      description: 'Compose a new email in Mail and send it, or save it as a draft (sendImmediately: false). to / cc / bcc are arrays of addresses; content is plain text; fromAccountId (from mail.accounts.list) picks the sending account, default account otherwise; attachments are absolute file paths inside a connected file location. Sending always comes back first as needs_confirmation with the exact from / to / subject — show it to the person and call again with confirmed: true. Saving a draft needs no confirmation (nothing leaves the computer).',
      risk: 'high',
      confirm: 'on_conflict',
      input_schema: {
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
          cc: { type: 'array', maxItems: 100, items: { type: 'string' } },
          bcc: { type: 'array', maxItems: 100, items: { type: 'string' } },
          subject: { type: 'string' },
          content: { type: 'string', description: 'Plain-text body.' },
          fromAccountId: { type: 'string', description: 'Account id from mail.accounts.list (its first address is used as the sender).' },
          attachments: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Absolute paths (or ~/…) of files to attach.' },
          sendImmediately: { type: 'boolean', description: 'true (default) sends; false only saves a draft in Mail.' },
          ...CONFIRMED,
        },
        additionalProperties: false,
      },
      validate(args) {
        const problem = checkRecipients(args, 'to', true) ?? checkRecipients(args, 'cc', false) ?? checkRecipients(args, 'bcc', false)
        if (problem) return problem
        for (const key of ['subject', 'content', 'fromAccountId']) if (args[key] !== undefined && typeof args[key] !== 'string') return `${key} must be a string`
        if (args.attachments !== undefined && (!strArray(args, 'attachments') || strArray(args, 'attachments')!.length > 20)) return 'attachments must be an array of at most 20 file paths'
        return null
      },
      async run(args, ctx) {
        const attached = await resolveAttachments(strArray(args, 'attachments') ?? [], ctx)
        if (!attached.ok) return attached.outcome
        const send = bool(args, 'sendImmediately') !== false
        const to = strArray(args, 'to') ?? []
        const cc = strArray(args, 'cc') ?? []
        const bcc = strArray(args, 'bcc') ?? []
        const subject = typeof args.subject === 'string' ? args.subject : ''
        const content = typeof args.content === 'string' ? args.content : ''
        let sender: string | undefined
        const fromAccountId = str(args, 'fromAccountId')
        if (fromAccountId) {
          const r = await mail(ctx, ACCOUNTS_SCRIPT, {})
          const account = (Array.isArray(r.accounts) ? (r.accounts as Array<{ id: string; emails: string[] }>) : []).find((a) => a.id === fromAccountId)
          if (!account) return bad(`No Mail account with id ${fromAccountId}: get the ids from mail.accounts.list.`)
          sender = account.emails[0]
          if (!sender) return bad(`Mail account ${fromAccountId} has no email address to send from.`)
        }
        if (send && args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
          const extra = [cc.length ? `抄送 ${cc.join('、')}` : '', bcc.length ? `密送 ${bcc.join('、')}` : '', attached.paths.length ? `附件 ${attached.paths.map((p) => path.basename(p)).join('、')}` : '']
            .filter(Boolean).join(',')
          const question = `要用${sender ? `「${sender}」` : '默认账户'}给 ${to.join('、')} 发主题为「${subject || '（无主题）'}」的邮件吗？${extra ? `（${extra}）` : ''}`
          return {
            ok: false,
            code: 'needs_confirmation',
            message: 'Sending email needs the person\'s approval: show them the question, then call again with confirmed: true.',
            confirm: { question, details: { from: sender ?? 'default account', to, cc, bcc, subject, content: preview(content, 500), attachments: attached.paths } },
          }
        }
        ctx.note(send ? '正在用「邮件」发信…' : '正在存草稿…')
        const r = await mail(ctx, SEND_SCRIPT, { to, cc, bcc, subject, content, sender, attachments: attached.paths, send })
        if (r.error === 'attach_failed') return fail('execution_failed', `Mail could not attach ${String(r.file)}: ${String(r.detail)}. Nothing was sent.`)
        const failure = scriptFailure(r, {})
        if (failure) return failure
        return ok({ sent: send, saved_as_draft: !send, from: r.sender ?? sender ?? null, to, cc, bcc, subject, attachments: attached.paths.length })
      },
    },
    {
      name: 'mail.reply',
      group: 'mail',
      title: '回复邮件',
      titleEn: 'Reply to email',
      description: 'Reply to a message (to its sender, or everyone with replyAll: true). content is put above the quoted original. Pass subject = the original message\'s subject exactly as listed: the person approves "reply to 「subject」" (needs_confirmation → call again with confirmed: true) and the reply is refused if the message\'s subject differs. sendImmediately: false saves the reply as a draft instead.',
      risk: 'high',
      confirm: 'always',
      input_schema: {
        type: 'object',
        required: ['messageId', 'subject'],
        properties: {
          messageId: MESSAGE_ID,
          ...HINT_PROPS,
          subject: { type: 'string', description: 'Subject of the message being replied to, as listed.' },
          content: { type: 'string', description: 'Reply text (plain).' },
          replyAll: { type: 'boolean' },
          sendImmediately: { type: 'boolean', description: 'true (default) sends; false saves a draft.' },
          ...CONFIRMED,
        },
        additionalProperties: false,
      },
      validate: (args) => messageIdError(args) ?? (typeof args.subject === 'string' ? null : 'subject (of the original message) is required'),
      question(args) {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        const who = bool(args, 'replyAll') ? '发件人和所有收件人' : '发件人'
        const verb = bool(args, 'sendImmediately') === false ? '写一封回复存成草稿' : '发一封回复'
        return `要给邮件「${preview(str(args, 'subject') || '（无主题）', 40)}」的${who}${verb}吗？${content ? `回复内容「${preview(content)}」` : '（不加正文）'}`
      },
      run: (args, ctx) => replyOrForward(args, ctx, false),
    },
    {
      name: 'mail.forward',
      group: 'mail',
      title: '转发邮件',
      titleEn: 'Forward email',
      description: 'Forward a message (with its attachments) to new recipients; content is put above the forwarded original. Pass subject = the original message\'s subject exactly as listed: the person approves "forward 「subject」 to …" (needs_confirmation → call again with confirmed: true) and the forward is refused if the subject differs. sendImmediately: false saves a draft instead.',
      risk: 'high',
      confirm: 'always',
      input_schema: {
        type: 'object',
        required: ['messageId', 'subject', 'to'],
        properties: {
          messageId: MESSAGE_ID,
          ...HINT_PROPS,
          subject: { type: 'string', description: 'Subject of the message being forwarded, as listed.' },
          to: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
          content: { type: 'string', description: 'Note above the forwarded message (plain text).' },
          sendImmediately: { type: 'boolean', description: 'true (default) sends; false saves a draft.' },
          ...CONFIRMED,
        },
        additionalProperties: false,
      },
      validate: (args) => messageIdError(args) ?? (typeof args.subject === 'string' ? null : 'subject (of the original message) is required') ?? checkRecipients(args, 'to', true),
      question(args) {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        const verb = bool(args, 'sendImmediately') === false ? '（先存成草稿）' : ''
        return `要把邮件「${preview(str(args, 'subject') || '（无主题）', 40)}」转发给 ${(strArray(args, 'to') ?? []).join('、')} 吗？${verb}${content ? `附言「${preview(content)}」` : ''}`
      },
      run: (args, ctx) => replyOrForward(args, ctx, true),
    },
  ]

  return {
    groups: [{
      id: 'mail',
      platforms: ['darwin'],
      iconApp: '/System/Applications/Mail.app',
      settingsUrl: MAC_PRIVACY('Privacy_Automation'),
      osPermission: '系统设置 → 隐私与安全性 → 自动化 → 咕咕 → 打开「邮件」',
      async probe(ctx) {
        await launchHidden(ctx)
        // 第一次会弹「允许咕咕控制邮件吗」:等人点(-1712 在 2 分钟左右回来),所以给足时间。
        await ctx.deps.jxa(PROBE_SCRIPT, {}, { app: APP, signal: ctx.signal, timeoutMs: 170_000 })
        return ok(null)
      },
    }],
    actions,
  }
}

async function replyOrForward(args: Args, ctx: FamilyContext, forward: boolean): Promise<Outcome> {
  const input = {
    messageId: num(args, 'messageId'),
    mailbox: str(args, 'mailbox') || undefined,
    accountId: str(args, 'accountId') || undefined,
    subject: typeof args.subject === 'string' ? args.subject : '',
    content: typeof args.content === 'string' ? args.content : '',
    replyAll: bool(args, 'replyAll') === true,
    to: forward ? strArray(args, 'to') ?? [] : [],
    forward,
    send: bool(args, 'sendImmediately') !== false,
  }
  ctx.note(forward ? '正在用「邮件」转发…' : '正在用「邮件」回复…')
  const r = await mail(ctx, REPLY_SCRIPT, input)
  if (r.error === 'subject_mismatch') {
    return bad(`Message ${input.messageId} has the subject "${String(r.subject)}", not "${input.subject}" that the person approved; nothing was ${forward ? 'forwarded' : 'sent'}. Check the id with mail.messages.list.`)
  }
  const failure = scriptFailure(r, input)
  if (failure) return failure
  return ok({ sent: input.send, saved_as_draft: !input.send, subject: r.subject, to: r.to, cc: r.cc })
}
