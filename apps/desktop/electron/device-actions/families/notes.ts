/**
 * 备忘录(notes.* 6 个):JXA 驱动「备忘录」App(macOS 自动化权限 → 备忘录)。备忘录的正文存的是 HTML:
 * 建 / 改收 HTML,读回 HTML + 纯文本。列表按文件夹整列取(id / 名字 / 修改时间一个 Apple Event 一列),
 * 只给最新的前 limit 条的摘要(纯文本前 200 字)。
 * 删除先问人,问句念的是 agent 给的标题,删前再核对一次 —— 对不上就不删。
 */
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import { bad, clampInt, fail, MAC_PRIVACY, num, ok, str, type ActionFamily, type Args, type FamilyContext, type Outcome } from '../catalog'

const APP = '备忘录'
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200
const SNIPPET_CHARS = 200
const BODY_MAX = 100_000

const NOTES_LIB = `
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
// 按 id 找一条备忘录:不存在(-1728)回 null;别的错(没授权 …)照样抛。
function noteById(app, id) {
  const n = app.notes.byId(id)
  try {
    n.id()
    return n
  } catch (e) {
    if (e && e.errorNumber === -1728) return null
    throw e
  }
}
function findFolder(app, name, accountName) {
  for (const acc of app.accounts()) {
    if (accountName && acc.name() !== accountName) continue
    const found = acc.folders.whose({ name: name })()
    if (found.length) return found[0]
  }
  return null
}
function folderNames(app, accountName) {
  const out = []
  for (const acc of app.accounts()) {
    if (accountName && acc.name() !== accountName) continue
    for (const n of acc.folders.name()) if (out.indexOf(n) < 0) out.push(n)
  }
  return out.slice(0, 60)
}
`

const FOLDERS_SCRIPT = `
function run(argv) {
  const app = Application('Notes')
  const out = []
  for (const acc of app.accounts()) {
    const accName = acc.name()
    const folders = acc.folders()
    const ids = acc.folders.id()
    const names = acc.folders.name()
    for (let i = 0; i < folders.length; i++) out.push({ id: ids[i], name: names[i], account: accName, notes: soft(() => folders[i].notes.length, 0) })
  }
  return JSON.stringify({ folders: out })
}
`

/**
 * 不点名文件夹时跳过「最近删除」(备忘录把删掉的条目留在那里 30 天;列出来会被当成还在的)。
 * 搜索交给「备忘录」自己按标题或正文筛(whose),❌ 把所有正文拉回来再筛。
 */
const LIST_SCRIPT = `
const TRASH = ['Recently Deleted', '最近删除', '最近刪除']
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Notes')
  const rows = []
  let folderFound = !p.folderName
  for (const acc of app.accounts()) {
    const accName = acc.name()
    if (p.accountName && accName !== p.accountName) continue
    const folders = acc.folders()
    const names = acc.folders.name()
    for (let f = 0; f < folders.length; f++) {
      if (p.folderName ? names[f] !== p.folderName : TRASH.indexOf(names[f]) >= 0) continue
      folderFound = true
      const notes = p.searchText ? folders[f].notes.whose({ _or: [{ name: { _contains: p.searchText } }, { plaintext: { _contains: p.searchText } }] }) : folders[f].notes
      const ids = notes.id()
      if (!ids.length) continue
      const titles = notes.name()
      const modified = soft(() => notes.modificationDate(), [])
      for (let i = 0; i < ids.length; i++) rows.push({ id: ids[i], name: titles[i] || '', folder: names[f], account: accName, t: modified[i] ? new Date(modified[i]).getTime() : 0, modified: iso(modified[i]) })
    }
  }
  if (!folderFound) return JSON.stringify({ error: 'folder_not_found', available: folderNames(app, p.accountName) })
  rows.sort((a, b) => b.t - a.t)
  const picked = rows.slice(0, p.limit)
  for (const r of picked) {
    delete r.t
    const n = app.notes.byId(r.id)
    r.locked = soft(() => n.passwordProtected(), false) === true
    const text = r.locked ? '' : String(soft(() => n.plaintext(), ''))
    r.snippet = text.slice(0, p.snippet + r.name.length + 2)
  }
  return JSON.stringify({ total: rows.length, notes: picked })
}
`

const GET_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Notes')
  const n = noteById(app, p.id)
  if (!n) return JSON.stringify({ error: 'not_found' })
  const locked = soft(() => n.passwordProtected(), false) === true
  const body = locked ? null : soft(() => n.body(), null)
  const text = locked ? null : soft(() => n.plaintext(), null)
  return JSON.stringify({
    id: n.id(), name: soft(() => n.name(), ''), folder: soft(() => n.container.name(), null),
    created: iso(soft(() => n.creationDate(), null)), modified: iso(soft(() => n.modificationDate(), null)),
    locked: locked, shared: soft(() => n.shared(), false) === true, attachments: soft(() => n.attachments.name(), []),
    body: body === null ? null : String(body).slice(0, p.max), body_length: body === null ? 0 : String(body).length,
    plaintext: text === null ? null : String(text).slice(0, p.max), plaintext_length: text === null ? 0 : String(text).length,
  })
}
`

/** 同一个文件夹里已经有同名的 → 先回 conflict 让人拍板(force = 已确认)。 */
const CREATE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Notes')
  let folder = null
  if (p.folderName) {
    folder = findFolder(app, p.folderName, p.accountName)
    if (!folder) return JSON.stringify({ error: 'folder_not_found', available: folderNames(app, p.accountName) })
  } else if (p.accountName) {
    const accs = app.accounts.whose({ name: p.accountName })()
    if (!accs.length) return JSON.stringify({ error: 'account_not_found', available: app.accounts.name() })
    folder = accs[0].defaultFolder()
  } else {
    folder = app.defaultAccount().defaultFolder()
  }
  const folderName = folder.name()
  if (!p.force) {
    const same = folder.notes.whose({ name: p.name })
    const ids = same.id()
    if (ids.length) return JSON.stringify({ conflict: true, folder: folderName, existing: ids.slice(0, 5) })
  }
  const props = { name: p.name }
  if (p.body) props.body = p.body
  const note = app.make({ new: 'note', at: folder, withProperties: props })
  return JSON.stringify({ id: soft(() => note.id(), null), name: soft(() => note.name(), p.name), folder: folderName })
}
`

const UPDATE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Notes')
  const n = noteById(app, p.id)
  if (!n) return JSON.stringify({ error: 'not_found' })
  if (soft(() => n.passwordProtected(), false) === true) return JSON.stringify({ error: 'locked' })
  if (p.body !== undefined) n.body = p.body
  if (p.name !== undefined) n.name = p.name
  return JSON.stringify({ id: n.id(), name: soft(() => n.name(), ''), modified: iso(soft(() => n.modificationDate(), null)) })
}
`

const DELETE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0])
  const app = Application('Notes')
  const n = noteById(app, p.id)
  if (!n) return JSON.stringify({ error: 'not_found' })
  const name = String(soft(() => n.name(), ''))
  if (name.trim() !== String(p.name).trim()) return JSON.stringify({ error: 'name_mismatch', name: name })
  app.delete(n)
  return JSON.stringify({ deleted: true, id: p.id, name: name })
}
`

const PROBE_SCRIPT = `
function run(argv) {
  return JSON.stringify({ folders: Application('Notes').folders.name().length })
}
`

/** 给测试用(逐个 osacompile 校验语法)。 */
export const NOTES_SCRIPTS = {
  folders: FOLDERS_SCRIPT, list: LIST_SCRIPT, get: GET_SCRIPT, create: CREATE_SCRIPT, update: UPDATE_SCRIPT, delete: DELETE_SCRIPT, probe: PROBE_SCRIPT,
} as const
export const NOTES_JXA_LIB = NOTES_LIB

type ScriptResult = Record<string, unknown> & { error?: string }

/** 「备忘录」没开着就先在后台隐藏启动;开着就不碰。 */
async function launchHidden(ctx: FamilyContext) {
  const running = await ctx.deps.exec('/usr/bin/pgrep', ['-x', 'Notes'], { signal: ctx.signal, timeoutMs: 5000 })
  if (running.code === 0) return
  await ctx.deps.exec('/usr/bin/open', ['-g', '-j', '-b', 'com.apple.Notes'], { signal: ctx.signal, timeoutMs: 15_000 })
}

async function notes(ctx: FamilyContext, script: string, input: unknown): Promise<ScriptResult> {
  await launchHidden(ctx)
  const value = await ctx.deps.jxa(NOTES_LIB + script, input, { app: APP, signal: ctx.signal, timeoutMs: 280_000 })
  if (!value || typeof value !== 'object') throw new Error('the Notes script returned nothing')
  return value as ScriptResult
}

function scriptFailure(r: ScriptResult, what: { id?: string; folderName?: string; accountName?: string }): Outcome | null {
  switch (r.error) {
    case undefined:
      return null
    case 'not_found':
      return bad(`No note with id ${what.id}: get ids from notes.list.`)
    case 'folder_not_found':
      return bad(`No folder "${what.folderName}"${what.accountName ? ` in account "${what.accountName}"` : ''}. Folders: ${(Array.isArray(r.available) ? r.available : []).join(', ') || 'none'}.`)
    case 'account_not_found':
      return bad(`No Notes account "${what.accountName}". Accounts: ${(Array.isArray(r.available) ? r.available : []).join(', ') || 'none'}.`)
    case 'locked':
      return fail('execution_failed', 'This note is locked with a password; it can only be changed in the Notes app after unlocking it.')
    default:
      return fail('execution_failed', `Notes: ${String(r.error)}`)
  }
}

const stringOrUndefined = (args: Args, key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined)
const checkStrings = (args: Args, keys: string[]) => keys.map((k) => (args[k] !== undefined && typeof args[k] !== 'string' ? `${k} must be a string` : null)).find(Boolean) ?? null
const idError = (args: Args) => (str(args, 'id') ? null : 'id is required (from notes.list)')
const CONFIRMED = { [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'true only after the person approved the question returned by needs_confirmation.' } }

/** 摘要:去掉开头那行标题(备忘录的纯文本以标题打头),空白压成一个空格,取前 200 字。 */
export function noteSnippet(name: string, plaintext: string): string {
  const text = plaintext.startsWith(name) ? plaintext.slice(name.length) : plaintext
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
}

export function createNotesFamily(): ActionFamily {
  return {
    groups: [{
      id: 'notes',
      platforms: ['darwin'],
      iconApp: '/System/Applications/Notes.app',
      settingsUrl: MAC_PRIVACY('Privacy_Automation'),
      osPermission: '系统设置 → 隐私与安全性 → 自动化 → 咕咕 → 打开「备忘录」',
      async probe(ctx) {
        await launchHidden(ctx)
        // 第一次会弹「允许咕咕控制备忘录吗」:等人点。
        await ctx.deps.jxa(PROBE_SCRIPT, {}, { app: APP, signal: ctx.signal, timeoutMs: 170_000 })
        return ok(null)
      },
    }],
    actions: [
      {
        name: 'notes.folders.list',
        group: 'notes',
        title: '列备忘录文件夹',
        titleEn: 'List note folders',
        description: 'List the folders in this Mac\'s Notes app: id, name, account (iCloud / On My Mac …) and how many notes each holds. Use the names as folderName.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        async run(_args, ctx) {
          const r = await notes(ctx, FOLDERS_SCRIPT, {})
          return scriptFailure(r, {}) ?? ok({ folders: Array.isArray(r.folders) ? r.folders : [] })
        },
      },
      {
        name: 'notes.list',
        group: 'notes',
        title: '列备忘录',
        titleEn: 'List notes',
        description: `List or search notes, most recently modified first: id, name (title), folder, account, modified, locked, snippet (first ${SNIPPET_CHARS} characters of plain text after the title). searchText matches the title or the body. Without folderName the "Recently Deleted" folder is skipped. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}; total tells how many matched. Read a whole note with notes.get.`,
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: {
            folderName: { type: 'string', description: 'Only this folder (name from notes.folders.list).' },
            accountName: { type: 'string', description: 'Only this account (e.g. "iCloud").' },
            searchText: { type: 'string', description: 'Title or body contains this text.' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          },
          additionalProperties: false,
        },
        validate: (args) => checkStrings(args, ['folderName', 'accountName', 'searchText']),
        async run(args, ctx) {
          const input = {
            folderName: str(args, 'folderName') || undefined,
            accountName: str(args, 'accountName') || undefined,
            searchText: str(args, 'searchText') || undefined,
            limit: clampInt(num(args, 'limit'), DEFAULT_LIMIT, 1, MAX_LIMIT),
            snippet: SNIPPET_CHARS,
          }
          ctx.note('正在读「备忘录」…')
          const r = await notes(ctx, LIST_SCRIPT, input)
          const failure = scriptFailure(r, input)
          if (failure) return failure
          const rows = (Array.isArray(r.notes) ? r.notes : []) as Array<{ name: string; snippet?: string }>
          const total = typeof r.total === 'number' ? r.total : rows.length
          return ok({ total, returned: rows.length, truncated: total > rows.length, notes: rows.map((n) => ({ ...n, snippet: noteSnippet(n.name, n.snippet ?? '') })) })
        },
      },
      {
        name: 'notes.get',
        group: 'notes',
        title: '读备忘录',
        titleEn: 'Read note',
        description: `Read one note by id (from notes.list): name, folder, created, modified, attachments (names), body (HTML, as Notes stores it) and plaintext — each up to ${BODY_MAX} characters (body_length / plaintext_length give the full size). Locked (password-protected) notes return no content.`,
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
        validate: idError,
        async run(args, ctx) {
          const input = { id: str(args, 'id'), max: BODY_MAX }
          const r = await notes(ctx, GET_SCRIPT, input)
          const failure = scriptFailure(r, input)
          if (failure) return failure
          return ok({ ...r, truncated: Number(r.body_length) > BODY_MAX || Number(r.plaintext_length) > BODY_MAX })
        },
      },
      {
        name: 'notes.create',
        group: 'notes',
        title: '建备忘录',
        titleEn: 'Create note',
        description: 'Create a note. name is the title; body is HTML (Notes stores HTML: <div>, <b>, <ul><li>, <br> … — escape <, >, & in plain text). folderName / accountName pick where it goes (default: the default folder). If that folder already has a note with the same title, it returns needs_confirmation first — ask the person, then call again with confirmed: true. Returns the new note\'s id.',
        risk: 'low',
        confirm: 'on_conflict',
        input_schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: 'Note title.' },
            body: { type: 'string', description: 'Note body as HTML.' },
            folderName: { type: 'string' },
            accountName: { type: 'string' },
            ...CONFIRMED,
          },
          additionalProperties: false,
        },
        validate: (args) => (str(args, 'name') ? checkStrings(args, ['body', 'folderName', 'accountName']) : 'name (the note title) is required'),
        async run(args, ctx) {
          const input = {
            name: str(args, 'name'),
            body: stringOrUndefined(args, 'body'),
            folderName: str(args, 'folderName') || undefined,
            accountName: str(args, 'accountName') || undefined,
            force: args[DEVICE_ACTION_CONFIRMED_ARG] === true,
          }
          const r = await notes(ctx, CREATE_SCRIPT, input)
          const failure = scriptFailure(r, input)
          if (failure) return failure
          if (r.conflict === true) {
            const existing = Array.isArray(r.existing) ? r.existing : []
            return {
              ok: false,
              code: 'needs_confirmation',
              message: `Folder "${String(r.folder)}" already has a note titled "${input.name}". Ask the person; call again with confirmed: true to create another one (or use notes.update on the existing note).`,
              confirm: { question: `备忘录文件夹「${String(r.folder)}」里已经有一条叫「${input.name}」的备忘录了，还要再建一条同名的吗？`, details: { folder: r.folder, existing } },
            }
          }
          if (!r.id) return ok({ ...r, warning: 'Notes created the note but did not return its id; do not retry — find it with notes.list.' })
          return ok(r)
        },
      },
      {
        name: 'notes.update',
        group: 'notes',
        title: '改备忘录',
        titleEn: 'Update note',
        description: 'Change a note\'s title (name) and/or replace its whole body (HTML). To edit part of a note, read it with notes.get first and send the complete new body. Locked notes cannot be changed.',
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' }, name: { type: 'string' }, body: { type: 'string', description: 'New body as HTML (replaces the entire body).' } },
          additionalProperties: false,
        },
        validate: (args) => idError(args) ?? checkStrings(args, ['name', 'body']) ?? (args.name !== undefined || args.body !== undefined ? null : 'give name and/or body'),
        async run(args, ctx) {
          const input = { id: str(args, 'id'), name: stringOrUndefined(args, 'name'), body: stringOrUndefined(args, 'body') }
          const r = await notes(ctx, UPDATE_SCRIPT, input)
          return scriptFailure(r, input) ?? ok(r)
        },
      },
      {
        name: 'notes.delete',
        group: 'notes',
        title: '删备忘录',
        titleEn: 'Delete note',
        description: 'Delete a note (Notes keeps it in "Recently Deleted" for 30 days). Give its id and its title (name) exactly as notes.list returned them: the person approves deleting 「name」 (needs_confirmation → call again with confirmed: true), and nothing is deleted if the note\'s title has changed.',
        risk: 'high',
        confirm: 'always',
        input_schema: {
          type: 'object',
          required: ['id', 'name'],
          properties: { id: { type: 'string' }, name: { type: 'string', description: 'The note\'s title, as listed.' }, ...CONFIRMED },
          additionalProperties: false,
        },
        validate: (args) => idError(args) ?? (typeof args.name === 'string' ? null : 'name (the note title, as listed) is required'),
        question: (args) => `要删除备忘录「${str(args, 'name') || '（无标题）'}」吗？（会先放进「最近删除」）`,
        async run(args, ctx) {
          const input = { id: str(args, 'id'), name: typeof args.name === 'string' ? args.name : '' }
          const r = await notes(ctx, DELETE_SCRIPT, input)
          if (r.error === 'name_mismatch') return bad(`Note ${input.id} is titled "${String(r.name)}", not "${input.name}" that the person approved; nothing was deleted.`)
          return scriptFailure(r, input) ?? ok({ deleted: true, id: input.id, name: r.name })
        },
      },
    ],
  }
}
