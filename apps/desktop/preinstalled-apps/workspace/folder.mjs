/* global gugu */ // An App program's gugu: the page's, for the page's own verbs (guide apps-programs).
// The 群文件夹 App's tools for an agent's chat folder (moved into the App 2026-10-11): list, read,
// create, edit, delete — the agent works on a chat's files the way it works on local ones: read, edit(old, new), create.
// Every one acts as the agent that calls it: a chat it hands (`gugu-chat`) or a file it hands (`gugu-file`) is checked as
// that agent at the gateway, and what the tool reads and writes there is the agent's, by its own membership.
// Only the public API: gugu.files, and Node's own modules for the files on this computer.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

const CHAT = {
  type: 'string',
  format: 'gugu-chat',
  description: 'The source group or private chat whose folder it is. A topic address uses its source folder. Use the delivery chat=, <project_group>\'s chat_id, or the number people see.',
}
const ITEM = { type: 'string', format: 'gugu-file', description: 'A file of a chat\'s folder: its id, as list or a gugu-file:// link gives it.' }
/** 子文件夹: a folder of a chat's folder, as the tools take it — by its path from the top, or its id. */
const FOLDER = {
  type: 'string',
  description: 'A folder in the chat\'s folder: its path from the top, such as 合同/2026 (made when it is not there), or its id. Left out: the top.',
}

/**
 * chat_id as gugu.files takes it, for every tool that takes one: text, as the gateway hands it — the number people see sent
 * as a JSON number is made text there, where the chat is checked as the agent (extension-gateway handedText), never here.
 * Anything else is refused before the folder is asked, saying what chat_id takes (A/B 10-12: the runtime's "Say where:
 * { chat: id } …" said nothing about chat_id).
 */
function chatOf(chatId) {
  if (typeof chatId === 'string' && chatId) return chatId
  throw new Error(`chat_id is a chat's id or the number people see (its 咕咕号), not ${typeof chatId === 'number' ? chatId : JSON.stringify(chatId)}`)
}

/** One answer's bytes at most: Codex cuts the middle of a longer one (the guides' budget, apps-programs). */
const PAGE_BYTES = 8000
/** A live text file's limit (the file service's), the same as a text file put there from this computer. */
const TEXT_MAX_BYTES = 1024 * 1024
const STORED_MAX_BYTES = 25 * 1024 * 1024
const bytesOf = (text) => Buffer.byteLength(text, 'utf8')

/** The file as a link, handed over whole: in a message it shows as that file and opens it (never assembled by the agent). */
const linkOf = (entry) => `[${entry.name.replace(/[[\]\\]/g, (c) => `\\${c}`)}](gugu-file://${entry.id})`
/** A file's link — a folder has none: it is listed and entered, never opened (子文件夹). */
const linked = (entry) => (entry.type === 'folder' ? {} : { link: linkOf(entry) })
const byOf = (entry) => (entry.createdBy?.id ? { id: entry.createdBy.id, name: entry.createdBy.name, kind: entry.createdBy.kind } : null)
const rowOf = (entry) => ({
  id: entry.id,
  name: entry.name,
  path: entry.path,
  type: entry.type,
  size: entry.size,
  by: byOf(entry),
  updated_at: entry.updatedAt,
  ...linked(entry),
})

/** `rows`, as every listing tool takes it: "20" is the first 20, "21-40" rows 21 to 40; default the first 20. */
function windowOf(rows) {
  const spec = String(rows ?? '20').trim()
  const range = /^(\d+)(?:-(\d+))?$/.exec(spec)
  if (!range) throw new Error(`rows takes "20" or "21-40", not ${JSON.stringify(spec)}`)
  const from = range[2] === undefined ? 1 : Number(range[1])
  const to = range[2] === undefined ? Number(range[1]) : Number(range[2])
  if (from < 1 || to < from) throw new Error(`rows ${spec} is no window: count from 1, the end not before the start`)
  return { from, to }
}

/** Absolute path of a file on this computer, read whole: what a tool puts in the folder as it is on disk. */
async function localFile(path, what) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${what}: path must be an absolute path on this computer, got ${JSON.stringify(path)}`)
  const info = await stat(path).catch((error) => {
    throw new Error(`${what}: cannot read ${path} (${error.code ?? error.message})`)
  })
  if (!info.isFile()) throw new Error(`${what}: ${path} is not a file`)
  if (info.size > STORED_MAX_BYTES) throw new Error(`${what}: ${path} is over the folder's 25 MiB`)
  const bytes = await readFile(path)
  // Changed while being read: nothing goes in rather than something nobody can name.
  if (bytes.length !== info.size) throw new Error(`${what}: ${path} changed while it was read; nothing was put in the folder`)
  return bytes
}

/** What the folder said, in the words an agent acts on; anything else as it was said. */
function said(error, itemId) {
  if (error?.code === 'not-found') return new Error(`no file ${itemId} in a chat you are in: list shows what is there`)
  const reason = error?.detail?.reason
  // 子文件夹: a folder is listed, never read or changed as a file.
  if (error?.code === 'invalid' && reason === 'folder') return new Error(`${itemId} is a folder: list it (folder: its path or id) to see what is in it`)
  if (error?.code === 'content-changed' && reason === 'old-not-found') {
    return new Error('old is not in the file: it changed since you read it, or old does not match it exactly. Read it again and retry.')
  }
  if (error?.code === 'ambiguous' && reason === 'old-matches-many') {
    return new Error('old matches several places: include more of the text around it, so it matches exactly one.')
  }
  return error
}

/** The file open for this call, closed when done: its last writes go to the file service before the answer does. */
async function withFile(itemId, options, work) {
  const f = await gugu.files.open({ id: itemId }, options).catch((error) => {
    throw said(error, itemId)
  })
  try {
    return await work(f)
  } catch (error) {
    throw said(error, itemId)
  } finally {
    f.close()
  }
}

/**
 * One page of a text file: a one-line JSON header, a blank line, then whole lines from `offset` verbatim — no line
 * numbers, no escaping, so `old` is copied from it exactly. At least one line per page: a line past the budget alone is
 * given whole, marked `over_budget`.
 */
export function pageOf(text, head, { offset, limit } = {}) {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1 && at + 1 < text.length; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const total = text.length ? starts.length : 0
  const endOf = (line) => (line < total ? starts[line] : text.length)
  const from = offset ?? 1
  if (!Number.isInteger(from) || from < 1) throw new Error(`offset is a line counted from 1, not ${offset}`)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`limit is a number of lines, not ${limit}`)
  const header = (lines, next, over) => JSON.stringify({ ...head, total_lines: total, lines, next_offset: next, ...(over ? { over_budget: true } : {}) })
  if (total === 0) {
    if (from !== 1) throw new Error(`offset ${from} is past the end: the file is empty`)
    return `${header(null, null, false)}\n\n`
  }
  if (from > total) throw new Error(`offset ${from} is past the end: the file has ${total} lines`)
  const last = limit === undefined ? total : Math.min(total, from + limit - 1)
  const room = PAGE_BYTES - bytesOf(header(`${total}-${total}`, total, true)) - 2
  const lineBytes = (line) => bytesOf(text.slice(starts[line - 1], endOf(line)))
  let to = from
  let used = lineBytes(from)
  while (to < last && used + lineBytes(to + 1) <= room) {
    to += 1
    used += lineBytes(to)
  }
  const next = to < total ? to + 1 : null
  return `${header(`${from}-${to}`, next, used > room)}\n\n${text.slice(starts[from - 1], endOf(to))}`
}

/**
 * A file's name on this computer (review 10-13) — its own name as far as a disk takes it, letters and digits of any script
 * kept (`中文报表.xlsx` stays so). Replaced: path separators, `: * ? " < > |` and control characters. Nothing but dots or
 * spaces (`.`, `..`) would name the folder itself: `file`. A Windows device name (CON, NUL, COM1, LPT1, CONIN$… with any
 * extension) swallows what is written: `_` before it. At most LOCAL_NAME_MAX_BYTES (a disk's name limit is 255), cut from
 * the stem at a character's edge so the extension stays. A dot or space at the very end becomes `_`: Node writes `report.`
 * as it is on Windows, and Explorer and PowerShell cannot open it.
 */
const LOCAL_NAME_MAX_BYTES = 200
export function localFileName(name) {
  let safe = String(name ?? '').replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
  if (/^[.\s]*$/.test(safe)) return 'file'
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(safe.split('.')[0].trimEnd())) safe = `_${safe}`
  if (Buffer.byteLength(safe) > LOCAL_NAME_MAX_BYTES) {
    const dot = safe.lastIndexOf('.')
    const ext = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : ''
    const stem = [...safe.slice(0, safe.length - ext.length)]
    while (stem.length > 1 && Buffer.byteLength(stem.join('') + ext) > LOCAL_NAME_MAX_BYTES) stem.pop()
    safe = stem.join('') + ext
  }
  return safe.replace(/[. ]+$/, (end) => '_'.repeat(end.length))
}

/**
 * A whole file saved on this computer, under the system's temp folder (never gugu's own data folder, F56). One folder per
 * agent, file and version (10-13): two agents on one machine (the owner's Claude and Codex) never write one copy — else
 * one's read wipes the other's change before it is stored, and the version check cannot see that; and an agent refused
 * for starting from a version gone by reads the new one beside the copy it changed, never over it. The same version read
 * again overwrites that version's copy. A call with no agent of its own is refused: never a folder every caller shares.
 */
async function saveLocally(entry, data, agent) {
  const who = String(agent ?? '').replace(/^user:/, '')
  if (!/^[A-Za-z0-9-]+$/.test(who)) throw new Error('read: only an agent saves into a folder of its own on this computer, and this call names no agent')
  const version = Number(entry.version)
  if (!Number.isInteger(version)) throw new Error(`read: ${entry.name} came back with no version`)
  const dir = join(tmpdir(), 'gugu-workspace', who, entry.id, `v${version}`)
  await mkdir(dir, { recursive: true })
  const path = join(dir, localFileName(entry.name))
  await writeFile(path, data)
  return { path, version }
}

export const list = {
  description:
    'The files in a chat\'s folder (群文件夹 of a source group or private chat), newest first: id, name, path (from the top: 合同/2026/甲方.pdf), type (folder for a subfolder), size, who made it, link; the header counts its text files, stored files and folders. folder lists only what is directly in that folder.',
  inputSchema: {
    type: 'object',
    required: ['chat_id'],
    properties: {
      chat_id: CHAT,
      folder: { ...FOLDER, description: 'Only what is directly in this folder: its path from the top (合同/2026) or its id; "" the top. Left out: everything, every folder included.' },
      name: { type: 'string', description: 'Only files whose name contains this.' },
      kind: {
        type: 'string',
        enum: ['document', 'file', 'folder'],
        description: 'document = a text or JSON file (read and edit it); file = stored bytes (an image, a PDF, a .pptx…); folder = a subfolder.',
      },
      rows: { type: 'string', description: 'Which rows: "20" the first 20 (default), "21-40" the next.' },
    },
  },
  annotations: { readOnlyHint: true },
  async run({ chat_id: given, folder, name, kind, rows }) {
    const chat_id = chatOf(given)
    const window = windowOf(rows)
    if (folder !== undefined && typeof folder !== 'string') throw new Error('folder is a folder\'s path from the top (合同/2026) or its id; "" the top')
    const all = await gugu.files.list(folder === undefined ? { chat: chat_id } : { chat: chat_id, folder })
    const kindOf = (entry) => (entry.type === 'folder' ? 'folder' : entry.type === 'binary' ? 'file' : 'document')
    const wanted = all.filter(
      (entry) =>
        (!name || entry.name.toLowerCase().includes(String(name).toLowerCase())) &&
        (!kind || kind === kindOf(entry)),
    )
    const shown = wanted.slice(window.from - 1, window.to)
    const size = window.to - window.from + 1
    return {
      chat_id,
      ...(folder === undefined ? {} : { folder }),
      documents: all.filter((entry) => kindOf(entry) === 'document').length,
      files: all.filter((entry) => kindOf(entry) === 'file').length,
      folders: all.filter((entry) => kindOf(entry) === 'folder').length,
      total: wanted.length,
      rows: shown.length ? `${window.from}-${window.from + shown.length - 1}` : null,
      next: window.to < wanted.length ? `${window.to + 1}-${window.to + size}` : null,
      items: shown.map(rowOf),
    }
  },
}

export const read = {
  description:
    'Read a file of a chat\'s folder. A text or JSON file comes a page at a time: a one-line JSON header, a blank line, then its lines verbatim — copy old for edit from them; next_offset reads on. A stored file (an image, a PDF, a .pptx…), or save: true, is saved whole on this computer in a folder of its own for that version; its path and version come back — the version edit\'s expected_version names when you store your change. A link\'s #lines=12-14 is the lines a person picked: read from offset 12 and change those, not the same words elsewhere.',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    properties: {
      item_id: ITEM,
      offset: { type: 'integer', minimum: 1, description: 'First line, counted from 1 (default 1): the last page\'s next_offset.' },
      limit: { type: 'integer', minimum: 1, description: 'At most this many lines (default: as many as fit in one page).' },
      save: { type: 'boolean', description: 'Save the whole file on this computer and answer with its path, instead of a page.' },
    },
  },
  annotations: { readOnlyHint: true },
  async run({ item_id, offset, limit, save }, { agent } = {}) {
    return withFile(item_id, { readOnly: true }, async (f) => {
      const entry = f.entry
      const head = { id: entry.id, name: entry.name, type: entry.type, by: byOf(entry), updated_at: entry.updatedAt, link: linkOf(entry) }
      if (f.type === 'binary' || save === true) {
        const data = f.type === 'binary' ? Buffer.from(await (await f.blob()).arrayBuffer()) : f.text
        const saved = await saveLocally(entry, data, agent)
        return { ...head, size: entry.size, version: saved.version, saved_to: saved.path }
      }
      return pageOf(f.text, head, { offset, limit })
    })
  },
}

export const create = {
  description:
    'Put a new file in a chat\'s folder: content makes a text file (markdown; JSON when the content is a JSON object), path puts a file from this computer there; folder puts it in that subfolder (made when it is not there), and folder alone makes the subfolder. A name already in that folder gets " (2)", " (3)": the answer says the name it got. Its link, in a message, opens it. A file made from a topic is in its source group or private chat\'s shared folder.',
  inputSchema: {
    type: 'object',
    required: ['chat_id'],
    properties: {
      chat_id: CHAT,
      folder: FOLDER,
      title: { type: 'string', description: 'The file\'s name. With content, needed; with path, the file\'s own name if left out.' },
      content: { type: 'string', description: 'The text of a new text file (up to 1 MiB): markdown, or a JSON object.' },
      path: { type: 'string', description: 'Absolute path of a file on this computer (up to 25 MiB). UTF-8 text up to 1 MiB goes in as a text file people edit together; anything else as stored bytes.' },
      source_message_ids: { type: 'array', items: { type: 'string' }, description: 'The messages it came from, by id: shown under the file.' },
    },
  },
  async run({ chat_id: given, folder, title, content, path, source_message_ids }) {
    const chat_id = chatOf(given)
    if (folder !== undefined && typeof folder !== 'string') throw new Error('folder is a folder\'s path from the top (合同/2026) or its id')
    // 子文件夹: folder alone (no content, no path) makes that folder, all the way down.
    if (content === undefined && path === undefined && typeof folder === 'string' && folder.trim()) {
      if (title !== undefined) throw new Error('create with folder alone makes that folder: name it in folder (合同/2026), without title')
      const made = await gugu.files.mkdir({ chat: chat_id, path: folder })
      return { created: { id: made.id, name: made.name, path: made.path, type: made.type } }
    }
    if ((content === undefined) === (path === undefined)) {
      throw new Error('create takes content (a new text file) or path (a file on this computer), one of them — or folder alone, to make that folder')
    }
    let file
    if (content !== undefined) {
      if (typeof title !== 'string' || !title.trim()) throw new Error('create with content needs a title')
      if (bytesOf(content) > TEXT_MAX_BYTES) throw new Error('content is over the 1 MiB of a text file: write it to a file and give its path')
      let json = false
      try {
        const parsed = JSON.parse(content)
        json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      } catch {}
      if (!json && /\.json$/i.test(title)) throw new Error(`${title} is a .json file: its content must be a JSON object at the top`)
      // A title without a type of its own is markdown, as a new text file always was; one that says .html or .csv keeps it.
      const type = json ? 'application/json' : /\.[A-Za-z0-9]+$/.test(title.trim()) ? '' : 'text/markdown'
      file = new File([content], title.trim(), { type })
    } else {
      const bytes = await localFile(path, 'create')
      file = new File([bytes], typeof title === 'string' && title.trim() ? title.trim() : basename(path))
    }
    const sourceMessageIds = (source_message_ids ?? []).map((id) => String(id).replace(/^msg:/, ''))
    const [entry] = await gugu.files.upload(folder === undefined ? { chat: chat_id } : { chat: chat_id, folder }, file, { sourceMessageIds })
    return {
      created: { id: entry.id, name: entry.name, path: entry.path, type: entry.type, size: entry.size },
      link: linkOf(entry),
      stored_as:
        entry.type === 'binary'
          ? `stored bytes (${entry.contentType}): read saves it on this computer; edit with path and the version read gave stores its next version`
          : 'a text file people and agents edit together: change it with edit (old, new)',
    }
  },
}

export const edit = {
  description:
    'Change a file of a chat\'s folder in place: old → new in a text or JSON file (old must match exactly one place; everyone who has it open sees the change at once), path with expected_version gives a stored file its next version (the earlier ones are kept), name renames it — a name with / moves it (合同/2026/甲方.pdf; /甲方.pdf to the top), a folder too, with all in it.',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    properties: {
      item_id: ITEM,
      old: { type: 'string', description: 'The text to replace, copied exactly from read (without its header line). It must match one place.' },
      new: { type: 'string', description: 'What goes in its place. A JSON file must still be a JSON object afterwards.' },
      path: { type: 'string', description: 'Absolute path of a file on this computer: the stored file\'s next version, with expected_version.' },
      expected_version: { type: 'integer', description: 'With path: the version you started from, as read gave it. If the file is no longer that version, nothing is written: read it again.' },
      name: {
        type: 'string',
        description: 'The file\'s new name: only its name changes. With /, its new place too: 合同/2026/甲方.pdf moves it into that folder (made when it is not there), /甲方.pdf to the top.',
      },
    },
  },
  async run({ item_id, old, new: next, path, expected_version, name }) {
    // Before the count: expected_version alone (nothing else) is told what it goes with, not that edit takes one change.
    if (expected_version !== undefined && path === undefined) throw new Error('expected_version goes with path: the version a stored file\'s next version starts from')
    const asked = [old !== undefined || next !== undefined, path !== undefined, name !== undefined].filter(Boolean).length
    if (asked !== 1) throw new Error('edit takes one change: old and new (the text), path (a stored file\'s next version), or name')
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name must not be empty')
      const wanted = name.trim()
      const taken = (error) => {
        if (error?.code === 'name-taken') return new Error(`${wanted}: that folder already has a file of that name (case not counted) — pick another name`)
        return said(error, item_id)
      }
      // 子文件夹: a name with / says where it goes as well (a leading / is the top).
      const slash = wanted.lastIndexOf('/')
      if (slash >= 0) {
        const base = wanted.slice(slash + 1).trim()
        if (!base) throw new Error(`name ${JSON.stringify(wanted)} ends with /: say the file's name after the folder`)
        const moved = await gugu.files.move({ id: item_id }, { folder: wanted.slice(0, slash), name: base }).catch((error) => {
          throw taken(error)
        })
        return { moved: { id: moved.id, name: moved.name, path: moved.path }, ...linked(moved) }
      }
      const renamed = await gugu.files.rename({ id: item_id }, wanted).catch((error) => {
        throw taken(error)
      })
      return { renamed: { id: renamed.id, name: renamed.name, path: renamed.path }, ...linked(renamed) }
    }
    if (path !== undefined) {
      const bytes = await localFile(path, 'edit')
      // Whether the version is there and still the file's is the folder's one check (files.replace, #7174) — the same for
      // a person's page, a program and the phone. Here only what it says is put in an agent's words.
      const expectedVersion = typeof expected_version === 'string' && /^\d+$/.test(expected_version) ? Number(expected_version) : expected_version
      const replaced = await gugu.files.replace({ id: item_id }, new Blob([bytes]), { expectedVersion }).catch((error) => {
        const reason = error?.detail?.reason
        if (error?.code === 'invalid' && reason === 'live-text-file') {
          throw new Error(`${item_id} is a text file: change it with old and new, never by replacing it`)
        }
        if (error?.code === 'invalid' && reason === 'expected-version') {
          throw new Error(expectedVersion === undefined
            ? 'edit with path needs expected_version: the version read gave when it saved the file you changed'
            : `expected_version is the version read gave, a whole number, not ${JSON.stringify(expected_version)}`)
        }
        if (error?.code === 'content-changed' && reason === 'replaced-since') {
          const { name, now, expected } = error.detail
          throw new Error(`${name}: you started from version ${expected}, it is version ${now} now — someone stored a newer one since you read it, and nothing was written. Read it again (it saves into that version's own folder, beside your copy), make your change there, and edit with that version.`)
        }
        throw said(error, item_id)
      })
      return { replaced: replaced.id, version: replaced.version, link: linkOf(replaced) }
    }
    if (typeof old !== 'string' || !old) throw new Error('old must not be empty: copy the text to replace from read')
    if (typeof next !== 'string') throw new Error('new is the text that goes in old\'s place (an empty string removes it)')
    if (old === next) throw new Error('old and new are the same: nothing to change')
    return withFile(item_id, {}, async (f) => {
      if (f.type === 'binary') throw new Error(`${f.entry.name} is a stored file: give its next version as path, with expected_version`)
      f.edit(old, next)
      return { edited: item_id }
    })
  },
}

const remove = {
  description:
    'Delete a file from a chat\'s folder, with its kept versions — or a subfolder with everything in it. Only whoever made them (you, or your owner) can; a folder holding something you cannot delete is left as it is.',
  inputSchema: { type: 'object', required: ['item_id'], properties: { item_id: ITEM } },
  async run({ item_id }) {
    await gugu.files.remove({ id: item_id }).catch((error) => {
      throw said(error, item_id)
    })
    return { deleted: item_id }
  },
}
export { remove as delete }
