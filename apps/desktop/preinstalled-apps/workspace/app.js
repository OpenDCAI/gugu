/* global gugu */ // window.gugu: the platform runtime puts it on the page before this module runs.
// 群文件夹 / 文件夹 (code: workspace) — the built-in App for a chat's workspace (a group's, a topic's or a private chat's): the file list, a
// markdown source editor with a preview, and JSON files as editable text. Several people and agents edit the same
// file at once.
//
// Built only on the public App API (the App platform's L3 runtime interface):
// gugu.getContext / onContextChanged, gugu.files.*, gugu.bind.codemirror, gugu.codemirror(), gugu.markdown(),
// presence, showMessage, openBrowserTab, clipboard and dispatch. It is the acceptance test of that API: anything it could not do
// through it is reported, not worked around.
//
// Where it runs is read from the context, never assumed: with a chat it shows that chat's
// workspace; with a file (ctx.file) it opens the file it was handed; with neither there is nothing to show.

import { placeOf, plainWords, relocate, spanOf } from './lines.js'

const $ = (id) => document.getElementById(id)

const STRINGS = {
  zh: {
    groupFolder: '群文件夹',
    folder: '文件夹',
    title: '{folder}',
    filter: '按文件名筛选',
    new: '新建',
    newDoc: '新建文档',
    newName: '新文档.md',
    newFolder: '新建文件夹',
    newFolderName: '新建文件夹',
    attachments: '附件',
    up: '上一级',
    move: '移动到…',
    moveTitle: '把「{name}」移到',
    here: '（现在在这里）',
    cancel: '取消',
    items: '{n} 项',
    confirmRemoveFolder: '删除它和里面的 {n} 项',
    nameTaken: '这个文件夹里已经有「{name}」了',
    alreadyThere: '「{name}」已经有了，新传的这份叫「{new}」。',
    keepBoth: '两个都留',
    replaceOld: '替换原来的',
    dropNew: '不要新传的',
    done: '好',
    noWorkspace: '这里没有对话的文件夹。在群里打开「群文件夹」、在私聊里打开「文件夹」，或者从对话里的文件「用文件夹打开」。',
    noFiles: '{folder}还是空的。',
    folderEmpty: '这个文件夹还是空的。',
    noMatch: '没有文件名含「{q}」的文件。',
    denied: '这个 App 没有读取{folder}的权限。',
    openWith: '用别的 App 打开',
    more: '更多',
    downloadOnly: '这个文件在这里只能下载，不能在这里看和改。',
    remove: '删除',
    confirmRemove: '确认删除',
    rename: '改名',
    online: '已连上',
    offline: '离线：改动会在回线后补上',
    gone: '这个文件不在了：被删掉了，或者你已经不在这个对话里。',
    readOnly: '只读',
    edit: '源码',
    split: '对照',
    preview: '预览',
    apply: '应用',
    discard: '放弃',
    jsonInvalid: '不是合法的 JSON：{e}',
    jsonNotObject: 'JSON 文件的最外层必须是对象 {…}',
    jsonRemote: '别人刚改了这个文件。应用时只写你改过的键。',
    copy: '复制',
    copied: '已复制',
    cite: '引用',
    hold: '＋ 记下',
    held: '{n} 处',
    heldClear: '全部取消',
    line: '第 {first} 行',
    lines: '第 {first}–{last} 行',
    placeMoved: '引用的那几行挪到了{lines}',
    placeGone: '引用的那几行之后改过了：这里是它们原来的位置',
    back: '文件',
    failed: '出错了：{e}',
    you: '你',
    justNow: '刚刚',
    upload: '上传',
    uploadTooLarge: '文件太大：{e}',
    download: '下载',
    createdBy: '{who} 创建 · {time}',
    editedBy: '{who} 编辑 · {time}',
    editedAt: '已编辑 · {time}',
    agent: 'Agent',
    system: '系统',
    sources: '来源消息',
    source: '第 {n} 条',
    sourceGone: '这条消息不在这个对话里了。',
  },
  en: {
    groupFolder: 'Group folder',
    folder: 'Folder',
    title: '{folder}',
    filter: 'Filter by name',
    new: 'New',
    newDoc: 'New document',
    newName: 'Untitled.md',
    newFolder: 'New folder',
    newFolderName: 'New folder',
    attachments: 'Attachments',
    up: 'Up',
    move: 'Move to…',
    moveTitle: 'Move “{name}” to',
    here: '(here now)',
    cancel: 'Cancel',
    items: '{n} items',
    confirmRemoveFolder: 'Delete it and its {n} items',
    nameTaken: '“{name}” is already in this folder',
    alreadyThere: '“{name}” was already here: the new one is “{new}”.',
    keepBoth: 'Keep both',
    replaceOld: 'Replace the old one',
    dropNew: 'Drop the new one',
    done: 'OK',
    noWorkspace: 'There is no chat folder here. Open Group folder in a group or Folder in a private chat, or open a file of one with it.',
    noFiles: 'No files here yet.',
    folderEmpty: 'This folder is empty.',
    noMatch: 'No file name contains “{q}”.',
    denied: 'This App may not read this folder.',
    openWith: 'Open with another App',
    more: 'More',
    downloadOnly: 'This file can only be downloaded here; it cannot be shown or changed here.',
    remove: 'Delete',
    confirmRemove: 'Confirm delete',
    rename: 'Rename',
    online: 'Connected',
    offline: 'Offline: changes catch up when back online',
    gone: 'This file is gone: it was deleted, or you are no longer in this chat.',
    readOnly: 'Read-only',
    edit: 'Source',
    split: 'Side by side',
    preview: 'Preview',
    apply: 'Apply',
    discard: 'Discard',
    jsonInvalid: 'Not valid JSON: {e}',
    jsonNotObject: 'A JSON file must hold an object {…} at the top',
    jsonRemote: 'Someone just changed this file. Applying writes only the keys you changed.',
    copy: 'Copy',
    copied: 'Copied',
    cite: 'Cite',
    hold: '+ Keep',
    held: '{n} spot{s}',
    heldClear: 'Clear all',
    line: 'Line {first}',
    lines: 'Lines {first}–{last}',
    placeMoved: 'The cited lines moved: {lines}',
    placeGone: 'The cited lines changed since: this is where they were',
    back: 'Files',
    failed: 'Something went wrong: {e}',
    you: 'You',
    justNow: 'just now',
    upload: 'Upload',
    uploadTooLarge: 'File too large: {e}',
    download: 'Download',
    createdBy: 'Created by {who} · {time}',
    editedBy: 'Edited by {who} · {time}',
    editedAt: 'Edited · {time}',
    agent: 'agent',
    system: 'System',
    sources: 'Source messages',
    source: '#{n}',
    sourceGone: 'That message is no longer in this chat.',
  },
}

const state = {
  ctx: null,
  t: stringsFor('zh', null),
  entries: [],
  listError: null,
  filter: '',
  folder: null, // the folder the list shows (子文件夹): a folder entry's id, null for the top
  dragging: null, // the entry being dragged onto a folder (desktop)
  mode: 'split',
  current: null, // { entry, file, view, unbind, offs: [] }
  opening: null,
  cm: null,
  md: null,
  picks: [], // the selection: { text, lines: [first, last] | null } per range (several, with Ctrl / Cmd in the source)
  held: [], // places kept with ＋ (refs), cited with the selection's
  listing: null, // the list asked last, on its way: { heard: [changes said meanwhile] }
  place: null, // { query: a pill's `at`, file: the file its link names }, waiting for that file's text to be drawn
  found: null, // what a pill's place showed, until the next press: { lines: [first, last] marked or null, said: in the banner }
  menuAnchor: null, // the ⋯ whose menu is open
  shown: null, // the entry on screen, text/JSON or binary: what Download saves
  titled: null, // the title last given to the host (setTabTitle)
}

const fmt = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))

function isZh(locale) {
  return String(locale || '').toLowerCase().startsWith('zh')
}

// The shared slot is bound to the source group or private chat; topics use that same folder.
function stringsFor(locale, chat) {
  const strings = isZh(locale) ? STRINGS.zh : STRINGS.en
  const folder = chat?.groupId ? strings.groupFolder : strings.folder
  return Object.fromEntries(Object.entries(strings).map(([key, text]) => [key, typeof text === 'string' ? text.replaceAll('{folder}', folder) : text]))
}

function can(capability) {
  return !!state.ctx?.capabilities?.includes(capability)
}
const canRead = () => can('files:read') || can('files:write')
const canWrite = () => can('files:write')

function debounce(fn, ms) {
  let timer = null
  return () => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

async function editorKit() {
  state.cm ??= await gugu.codemirror()
  return state.cm
}

// The preview is gugu's own markdown rendering — the dialect, look and link rules every other surface has — not a parse
// of this App's: the editor's parser only colours the source.
async function previewKit() {
  state.md ??= await gugu.markdown()
  return state.md
}

// A Workspace page starts when its folder or file is opened. Prepare its existing reader while it awaits context.
const previewReady = previewKit().then((md) => ({ md }), (error) => ({ error }))

// GFM (tables, strikethrough, task items).
function markdownSupport(cm) {
  return cm.markdown({ base: cm.markdownLanguage })
}

// ─── context ────────────────────────────────────────────────────────────────

async function applyContext(ctx) {
  const previous = state.ctx
  state.ctx = ctx
  state.t = stringsFor(ctx.locale, ctx.chat)
  document.documentElement.lang = isZh(ctx.locale) ? 'zh-CN' : 'en'
  renderChrome()
  const inGroup = !!ctx.chat
  // A page the host opened for one file (F3: its own page, bound to that file for life) shows that file only.
  document.body.classList.toggle('no-list', !inGroup || !canRead() || !!ctx.file)
  if (previous?.chat?.id !== ctx.chat?.id || !!previous?.file !== !!ctx.file) {
    // Adds, deletes and renames in this chat's workspace (§2.4: fed from workspace_changed) — every call names its chat.
    state.unwatch?.()
    state.unwatch = inGroup && canRead() && !ctx.file ? gugu.files.onChanged({ chat: ctx.chat.id }, heard) : null
    if (inGroup && canRead() && !ctx.file) await refreshList()
  }
  // The host hands this page a file when it picked this App for it (真源 §2.6: a click goes to the host,
  // which picks the most specific claim; .md and plain .json are this App's). The host's header then has
  // the way back, so this page's own Back is not drawn; going back takes the file away again.
  document.body.classList.toggle('host-opened', !!ctx.file)
  if (ctx.file && state.current?.entry.id !== ctx.file.id && state.opening?.id !== ctx.file.id) await openHanded()
  else if (!ctx.file && previous?.file) {
    closeCurrent()
    document.body.classList.remove('show-doc')
  }
  if (!inGroup && !ctx.file) showDocMessage(state.t.noWorkspace)
  else if (!canRead() && !ctx.file) showDocMessage(state.t.denied)
  // Layout and visibility reports change context too; they must not rebuild every row or erase a rename draft.
  if (previous && (previous.locale !== ctx.locale || !!previous.file !== !!ctx.file || previous.capabilities?.join('\0') !== ctx.capabilities?.join('\0'))) renderList()
}

function renderChrome() {
  const t = state.t
  const title = state.ctx?.file?.id && state.ctx.file.id === state.shown?.id ? state.shown.name : t.title
  document.title = title
  // The slot's header says this App's name in the person's language (it would show the manifest's 文件夹 otherwise).
  if (state.titled !== title) {
    state.titled = title
    Promise.resolve(gugu.setTabTitle(title)).catch(() => {})
  }
  $('filter').placeholder = t.filter
  $('new-label').textContent = t.new
  $('new-doc').hidden = !canWrite()
  $('move-cancel').textContent = t.cancel
  $('conflicts-done').textContent = t.done
  $('upload-label').textContent = $('empty-upload').textContent = t.upload
  $('upload').hidden = !canWrite()
  $('download').textContent = t.download
  $('open-with').textContent = t.openWith
  $('more').setAttribute('aria-label', t.more)
  $('more').title = t.more
  for (const mode of ['edit', 'split', 'preview']) $(`mode-${mode}`).textContent = t[mode]
  $('json-apply').textContent = t.apply
  $('json-discard').textContent = t.discard
  $('copy-sel').textContent = t.copy
  $('cite-sel').textContent = t.cite
  $('hold-sel').textContent = t.hold
  $('held-cite').textContent = t.cite
  $('held-clear').title = t.heldClear
  $('held-clear').setAttribute('aria-label', t.heldClear)
  renderHeld()
}

// ─── list ───────────────────────────────────────────────────────────────────

// The newest list asked is the one shown (an older one back later — another chat's — is dropped); what the chat says
// while it is on its way goes over it again when it is back: the list may be from before (#7257).
async function refreshList() {
  if (!state.ctx?.chat || !canRead()) return
  const asked = (state.listing = { heard: [] })
  let entries
  let listError = null
  try {
    entries = await gugu.files.list({ chat: state.ctx.chat.id })
  } catch (error) {
    entries = []
    listError = error.code === 'denied' ? state.t.denied : fmt(state.t.failed, { e: error.message })
  }
  if (state.listing !== asked) return
  state.listing = null
  state.entries = entries
  state.listError = listError
  for (const change of asked.heard) take(change)
  showList()
}

// What the chat says of its files (#7257): those as they are now, and the ids no longer there — into the list as it is,
// never listed again.
function heard(change) {
  if (change.kind !== 'entries') return
  state.listing?.heard.push(change)
  take(change)
  showList()
}

function take(change) {
  const fresh = new Map(change.entries.map((entry) => [entry.id, entry]))
  state.entries = [...state.entries.filter((entry) => !fresh.has(entry.id) && !change.gone.includes(entry.id)), ...fresh.values()]
}

function showList() {
  renderList()
  // The file on screen was renamed elsewhere: the list is the truth for its entry.
  const fresh = state.shown && state.entries.find((e) => e.id === state.shown.id)
  if (fresh) {
    if (state.current?.entry.id === fresh.id) state.current.entry = fresh
    if (!$('doc-title').contains(document.activeElement)) $('doc-title').textContent = fresh.name
    showEntry(fresh)
  }
}

function relativeTime(iso) {
  if (!iso) return ''
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000)
  if (!Number.isFinite(seconds)) return ''
  if (Math.abs(seconds) < 45) return state.t.justNow
  const rtf = new Intl.RelativeTimeFormat(state.ctx?.locale || 'en', { numeric: 'auto' })
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return rtf.format(seconds, 'second')
}

// When a file last changed: its last edit, else its making.
const changedAt = (entry) => entry.updatedAt ?? entry.createdAt

const isFolder = (entry) => entry.type === 'folder'
// What is directly in each folder, made once per list of entries (state.entries is replaced, never changed in place): a
// drawing of the list, and every dragover, asks it for every folder row.
let children = { of: null, map: new Map() }
function inside(folderId) {
  if (children.of !== state.entries) {
    const map = new Map()
    for (const e of state.entries) {
      const at = e.parentId ?? null
      if (!map.has(at)) map.set(at, [])
      map.get(at).push(e)
    }
    children = { of: state.entries, map }
  }
  return children.map.get(folderId) ?? []
}
// Where an entry is from the top, by its folders' names as the list has them now: an entry's own `path` was read with it,
// and a folder above it renamed or moved since leaves that stale (only the changed row is read again).
function pathOf(entry) {
  const names = []
  for (let at = entry, hops = 0; at && hops <= 64; at = at.parentId ? state.entries.find((e) => e.id === at.parentId) : null, hops++) names.unshift(at.name)
  return names.join('/')
}

// Everything under a folder, however deep: what its delete takes with it, and where it cannot be moved into.
function under(folderId) {
  const found = []
  for (let next = inside(folderId); next.length; next = next.flatMap((e) => (isFolder(e) ? inside(e.id) : []))) found.push(...next)
  return found
}

// The order of one folder (子文件夹): its folders first — 「附件」 at the head, the rest by name — then its files, the newest
// change first.
function inOrder(a, b) {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1
  if (isFolder(a)) {
    if (!!a.systemRole !== !!b.systemRole) return a.systemRole ? -1 : 1
    return shownName(a).localeCompare(shownName(b), state.ctx?.locale || undefined)
  }
  return (Date.parse(changedAt(b)) || 0) - (Date.parse(changedAt(a)) || 0)
}

// One list, one scroll: the folder on screen (子文件夹) — or, while filtering, every file whose name matches, wherever it
// is. The same two-line rows say who made each file and when it last changed at every width.
function renderList() {
  // A name being typed (改名, a new folder's name) is not drawn over — a change heard meanwhile is in state.entries, and
  // the list is drawn when the name is done (finish → refreshList).
  if (document.activeElement?.classList?.contains('rename-input')) return
  const t = state.t
  const list = $('file-list')
  const empty = $('files-empty')
  // The folder on screen is gone (deleted, or no longer seen): back to the top.
  if (state.folder && !state.entries.some((e) => e.id === state.folder)) state.folder = null
  renderCrumbs()
  const needle = state.filter.trim().toLocaleLowerCase()
  const shown = (needle ? state.entries : inside(state.folder))
    .filter((e) => !needle || e.name.toLocaleLowerCase().includes(needle) || shownName(e).toLocaleLowerCase().includes(needle))
    .sort(inOrder)
  list.replaceChildren(...shown.map(listItem))
  // A row's menu goes with its row (the list is drawn anew when the workspace changes).
  if (state.menuAnchor && !state.menuAnchor.isConnected) closeMenu()
  empty.hidden = shown.length > 0
  $('files-empty-message').textContent = state.listError ?? (needle ? fmt(t.noMatch, { q: state.filter.trim() }) : state.folder ? t.folderEmpty : t.noFiles)
  $('empty-upload').hidden = !canWrite() || !!needle || !!state.listError
}

// The way up and each folder from the top (子文件夹): a press goes there, a dropped file moves there. Not drawn at the top.
function renderCrumbs() {
  const nav = $('crumbs')
  const t = state.t
  if (!state.folder || state.filter.trim()) {
    nav.hidden = true
    nav.replaceChildren()
    return
  }
  const trail = []
  for (let at = state.entries.find((e) => e.id === state.folder); at; at = state.entries.find((e) => e.id === at.parentId)) trail.unshift(at)
  const up = document.createElement('button')
  up.type = 'button'
  up.className = 'back'
  up.innerHTML = '<gugu-icon name="chevron-left"></gugu-icon>'
  up.append(Object.assign(document.createElement('span'), { textContent: t.up }))
  up.onclick = () => enterFolder(trail.length > 1 ? trail[trail.length - 2].id : null)
  const crumb = (text, folderId, current) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crumb'
    button.textContent = text
    if (current) button.setAttribute('aria-current', 'page')
    else button.onclick = () => enterFolder(folderId)
    dropOnto(button, folderId)
    return button
  }
  const parts = [up, crumb(t.title, null, false)]
  trail.forEach((folder, i) => {
    parts.push(Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '/' }))
    parts.push(crumb(shownName(folder), folder.id, i === trail.length - 1))
  })
  nav.replaceChildren(...parts)
  nav.hidden = false
}

function enterFolder(folderId) {
  hideBanner()
  state.folder = folderId
  if (state.filter) {
    state.filter = ''
    $('filter').value = ''
  }
  renderList()
  $('file-list').scrollTop = 0
}

// A row or a crumb a dragged file can land on (desktop): the folder it stands for (null, the top).
function dropOnto(el, folderId) {
  const fits = () => {
    const moving = state.dragging
    if (!moving || !canWrite() || (moving.parentId ?? null) === folderId || moving.id === folderId) return false
    return !(isFolder(moving) && under(moving.id).some((e) => e.id === folderId))
  }
  el.addEventListener('dragover', (event) => {
    if (!fits()) return
    event.preventDefault()
    el.classList.add('drop-target')
  })
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
  el.addEventListener('drop', (event) => {
    el.classList.remove('drop-target')
    if (!fits()) return
    event.preventDefault()
    const moving = state.dragging
    state.dragging = null
    moveTo(moving, folderId)
  })
}

async function moveTo(entry, folderId) {
  hideBanner()
  try {
    await gugu.files.move(entry, { folder: folderId ?? '' })
  } catch (error) {
    showBanner(error.code === 'name-taken' ? fmt(state.t.nameTaken, { name: entry.name }) : fmt(state.t.failed, { e: error.message }), 'error')
  }
  await refreshList()
}

// 「移动到…」: every folder of the chat, the top first, each under the one it is in; not the entry itself or what is
// under it (a folder cannot go inside itself). Where it is now is marked and cannot be picked.
function showMoveDialog(entry) {
  const t = state.t
  const off = new Set(isFolder(entry) ? [entry.id, ...under(entry.id).map((e) => e.id)] : [])
  const rows = []
  const add = (folderId, depth) => {
    for (const folder of inside(folderId).filter(isFolder).sort(inOrder)) {
      if (off.has(folder.id)) continue
      rows.push({ id: folder.id, name: shownName(folder), depth })
      add(folder.id, depth + 1)
    }
  }
  rows.push({ id: null, name: t.title, depth: 0 })
  add(null, 1)
  $('move-title').textContent = fmt(t.moveTitle, { name: shownName(entry) })
  $('move-targets').replaceChildren(...rows.map((row) => {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'move-target'
    button.style.paddingInlineStart = `${8 + row.depth * 16}px`
    button.append(folderMark(), Object.assign(document.createElement('span'), { textContent: row.name }))
    const here = (entry.parentId ?? null) === row.id
    if (here) {
      button.disabled = true
      button.append(Object.assign(document.createElement('span'), { className: 'file-path', textContent: t.here }))
    }
    button.onclick = () => {
      closeMoveDialog()
      moveTo(entry, row.id)
    }
    li.append(button)
    return li
  }))
  $('move-dialog').hidden = false
  $('move-targets').querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
}

function closeMoveDialog() {
  $('move-dialog').hidden = true
  $('move-targets').replaceChildren()
}

function folderMark() {
  const mark = document.createElement('gugu-icon')
  mark.className = 'file-mark'
  mark.setAttribute('name', 'folder')
  return mark
}

// A person or an agent by name, the system as itself (entry.createdBy, §2.4).
function who(person) {
  if (person.kind === 'system') return state.t.system
  const name = person.name || person.id.slice(0, 6)
  return person.kind === 'agent' ? `${name} (${state.t.agent})` : name
}

// Creation and editing are separate facts: the creator must never be paired with the last edit's time.
function activityOf(entry) {
  if (!entry) return []
  return [
    entry.createdBy && !entry.systemRole ? fmt(state.t.createdBy, { who: who(entry.createdBy), time: relativeTime(entry.createdAt) }) : relativeTime(entry.createdAt),
    entry.updatedAt && (entry.updatedBy || entry.createdAt && Date.parse(entry.updatedAt) > Date.parse(entry.createdAt))
      ? fmt(entry.updatedBy ? state.t.editedBy : state.t.editedAt, {
        who: entry.updatedBy ? who(entry.updatedBy) : '', time: relativeTime(entry.updatedAt),
      }) : '',
  ].filter(Boolean)
}

// F39 (L5) People read "周五聚餐吃什么", not "周五聚餐吃什么.dinner-vote.json": the host drops the suffix an App claims the
// file by (entry.displayName) and says which App (entry.claimedBy) — this page never reads suffixes itself. 「附件」 goes by
// its role (子文件夹): the folder gugu keeps for a chat's attachments, named in the person's language.
function shownName(entry) {
  if (entry.systemRole === 'attachments') return state.t.attachments
  return entry.displayName
}

// A file's mark: the icon the App that opens it declared for its kind (entry.claimedBy.icon, worked out by the host), or
// gugu's generic file glyph by what it is — never the App's own icon (owner 10-17: a markdown file drawn as a folder).
// Hovered, it still says which App opens it.
function fileMark(entry) {
  const icon = entry.claimedBy?.icon
  const mark = document.createElement(icon ? 'img' : 'gugu-icon')
  mark.className = 'file-mark'
  if (entry.claimedBy) mark.title = entry.claimedBy.name
  if (icon) Object.assign(mark, { src: icon, alt: entry.claimedBy?.name ?? '' })
  else mark.setAttribute('name', entry.contentType.startsWith('image/') ? 'file-image' : entry.type === 'binary' ? 'file' : 'file-text')
  return mark
}

function listItem(entry) {
  const t = state.t
  const li = document.createElement('li')
  li.className = 'file'
  li.dataset.id = entry.id
  li.setAttribute('role', 'option')
  li.setAttribute('aria-selected', String(state.current?.entry.id === entry.id))
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'file-open'
  const title = document.createElement('span')
  title.className = 'file-title'
  const name = document.createElement('span')
  name.className = 'file-name'
  name.textContent = shownName(entry)
  const folder = isFolder(entry)
  if (folder) {
    li.dataset.folder = ''
    if (entry.systemRole) li.dataset.system = entry.systemRole
    title.append(folderMark())
  } else {
    title.append(fileMark(entry))
  }
  title.append(name)
  // The whole name — suffix included — stays one hover (and the details) away; where it is, when the list is a search.
  open.title = pathOf(entry)
  // Who made it and when, then a separate edit time (folders also say how much is in them).
  const meta = document.createElement('span')
  meta.className = 'file-meta'
  for (const text of activityOf(entry)) meta.append(Object.assign(document.createElement('span'), { className: 'file-activity', textContent: text }))
  if (folder) meta.append(Object.assign(document.createElement('span'), { textContent: fmt(t.items, { n: inside(entry.id).length }) }))
  open.append(title)
  const where = state.filter.trim() && entry.parentId ? pathOf(entry).split('/').slice(0, -1).join('/') : ''
  if (where) meta.prepend(Object.assign(document.createElement('span'), { className: 'file-path', textContent: where }))
  open.append(meta)
  open.onclick = () => (folder ? enterFolder(entry.id) : openInHost(entry))
  // Files carry the same resource link outside this App; folder moves stay inside it.
  const drag = (text, isLink) => {
    li.draggable = true
    li.addEventListener('dragstart', (event) => {
      state.dragging = entry
      event.dataTransfer?.setData('text/plain', text)
      if (isLink) event.dataTransfer?.setData('text/uri-list', text)
    })
    li.addEventListener('dragend', () => (state.dragging = null))
  }
  if (folder) {
    if (canWrite() && !entry.systemRole) drag(entry.name, false)
  } else {
    // DataTransfer is writable only during dragstart, before any asynchronous host answer.
    void gugu.linkTo({ kind: 'file', file: entry }).then((link) => drag(link, true))
      .catch((error) => showBanner(fmt(state.t.failed, { e: error.message }), 'error'))
  }
  if (folder) dropOnto(li, entry.id)
  // One ⋯ per row: the other Apps that open the file (the host's picker, this App included), rename, move, delete. 「附件」
  // is gugu's: nothing to do to it here (what is in it is managed like any file).
  const items = []
  if (!folder) items.push([t.openWith, () => openInHost(entry, true)])
  if (canWrite() && !entry.systemRole) {
    const count = folder ? under(entry.id).length : 0
    items.push([t.rename, () => startRename(li, entry)], [t.move, () => showMoveDialog(entry)])
    // Delete only where the folder says this person may (entry.canDelete: who made it, or the chat's owner or an admin).
    if (entry.canDelete) items.push([t.remove, () => removeFile(entry), folder && count ? fmt(t.confirmRemoveFolder, { n: count }) : t.confirmRemove])
  }
  if (items.length === 0) {
    li.append(open)
    return li
  }
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'row-more'
  more.innerHTML = '<gugu-icon name="more-horizontal"></gugu-icon>'
  more.setAttribute('aria-label', t.more)
  more.setAttribute('aria-haspopup', 'menu')
  more.onclick = () => toggleMenu(more, items)
  li.append(open, more)
  return li
}

// A file manager: a click hands the file to the host, which picks the App that opens it — the most specific
// claim in the chat, or the person's "always use it" (真源 §2.6). When that is this App (.md, plain .json)
// the host hands the file back as context.file and applyContext opens it; nothing opens inline on a click.
// `ask`: "Open with another App" — the host's picker, every App that opens this file, this one included.
async function openInHost(entry, ask = false) {
  try {
    await (ask ? gugu.files.openWith(entry, { ask: true }) : gugu.files.openWith(entry))
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

function startRename(li, entry) {
  // Dragging in the field selects its text: the row is not dragged meanwhile.
  li.draggable = false
  const input = document.createElement('input')
  input.className = 'rename-input'
  input.setAttribute('aria-label', state.t.rename)
  input.value = entry.name
  li.replaceChildren(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    input.blur()
    const name = input.value.trim()
    if (commit && name && name !== entry.name) {
      hideBanner()
      try {
        await gugu.files.rename(entry, name)
      } catch (error) {
        showBanner(error.code === 'name-taken' ? fmt(state.t.nameTaken, { name }) : fmt(state.t.failed, { e: error.message }), 'error')
      }
    }
    await refreshList()
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') finish(true)
    if (event.key === 'Escape') finish(false)
  }
  input.onblur = () => finish(true)
}

// A name not yet in the folder on screen, from a template (「新文档.md」, 「新建文件夹」): with 2, 3, … before its suffix.
function freeName(template) {
  const taken = new Set(inside(state.folder).map((e) => e.name.toLocaleLowerCase()))
  let name = template
  for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) name = template.replace(/(\.md)?$/, ` ${n}$1`)
  return name
}

async function createDoc() {
  hideBanner()
  try {
    const name = freeName(state.t.newName)
    const entry = await gugu.files.create({ chat: state.ctx.chat.id, name, ...(state.folder ? { folder: state.folder } : {}) }, '')
    // Opened the way a click opens it, while the click that made it still counts as the person's gesture.
    await openInHost(entry)
    await refreshList()
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

// 子文件夹: a new folder in the one on screen, named straight away (its name field open on its row).
async function createFolder() {
  hideBanner()
  try {
    const shown = state.folder ? state.entries.find((e) => e.id === state.folder) : null
    const here = shown ? pathOf(shown) : ''
    const entry = await gugu.files.mkdir({ chat: state.ctx.chat.id, path: here ? `${here}/${freeName(state.t.newFolderName)}` : freeName(state.t.newFolderName) })
    await refreshList()
    const li = $('file-list').querySelector(`[data-id="${CSS.escape(entry.id)}"]`)
    if (li) startRename(li, state.entries.find((e) => e.id === entry.id) ?? entry)
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

async function uploadFiles() {
  hideBanner()
  // One upload at a time: the button is back once the files are in the list and anything to ask is asked.
  $('upload').disabled = true
  try {
    const before = new Set(state.entries.map((e) => e.id))
    // The host's file picker, into the folder on screen; [] when the person cancels.
    const arrived = await gugu.files.upload({ chat: state.ctx.chat.id, ...(state.folder ? { folder: state.folder } : {}) })
    // What arrived is in the list, to open like any other file (the picker took the gesture's time).
    await refreshList()
    askAboutNames(arrived, before)
  } catch (error) {
    // A partial failure rejects too, after the rest are stored: the list shows what arrived.
    await refreshList()
    showBanner(fmt(error.code === 'too-large' ? state.t.uploadTooLarge : state.t.failed, { e: error.message }), 'error')
  } finally {
    $('upload').disabled = false
  }
}

async function downloadShown() {
  if (!state.shown) return
  try {
    await gugu.files.download(state.shown) // false: the person cancelled the save dialog, nothing to say
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

// A name that was already there (子文件夹): the folder kept both — the database gave the new one 「 (n)」. The host says
// which file it clashed with (`clashWith`): this page never guesses from a name (a file picked as 「photo (2).jpg」 is just
// that; an NFD name from macOS is the same name). Asked once the files are in: keep both, or put the new content in the
// old file (its next version; a text file cannot be replaced, so its new copy can only be dropped).
function askAboutNames(arrived, before) {
  const t = state.t
  const clashes = []
  for (const entry of arrived) {
    const old = entry.clashWith ? state.entries.find((e) => e.id === entry.clashWith && before.has(e.id)) : null
    if (old && !isFolder(old)) clashes.push({ entry, old })
  }
  if (clashes.length === 0) return
  $('conflict-list').replaceChildren(...clashes.map(({ entry, old }) => {
    const li = document.createElement('li')
    li.className = 'conflict'
    li.append(Object.assign(document.createElement('span'), { textContent: fmt(t.alreadyThere, { name: old.name, new: entry.name }) }))
    const actions = document.createElement('div')
    actions.className = 'conflict-actions'
    const act = (text, run) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.onclick = async () => {
        for (const b of actions.querySelectorAll('button')) b.disabled = true
        try {
          await run()
          li.remove()
          if (!$('conflict-list').children.length) $('conflicts').hidden = true
        } catch (error) {
          showBanner(fmt(t.failed, { e: error.message }), 'error')
          for (const b of actions.querySelectorAll('button')) b.disabled = false
        }
        await refreshList()
      }
      return button
    }
    actions.append(act(t.keepBoth, async () => undefined))
    if (entry.type === 'binary' && old.type === 'binary') {
      actions.append(act(t.replaceOld, async () => {
        const file = await gugu.files.open(entry, { readOnly: true })
        const blob = await file.blob()
        file.close()
        await gugu.files.replace(old, blob, { expectedVersion: old.version })
        await gugu.files.remove(entry)
      }))
    } else {
      actions.append(act(t.dropNew, () => gugu.files.remove(entry)))
    }
    li.append(actions)
    return li
  }))
  $('conflicts').hidden = false
}

async function removeFile(entry) {
  hideBanner()
  try {
    if (state.current?.entry.id === entry.id) closeCurrent()
    await gugu.files.remove(entry)
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
  await refreshList()
}

// ─── the open file ──────────────────────────────────────────────────────────

function closeCurrent() {
  const current = state.current
  if (!current) return
  state.current = null
  for (const off of current.offs) off()
  current.unbind?.()
  current.view?.destroy()
  current.file?.close()
  $('editor').replaceChildren()
  $('preview').replaceChildren()
  $('peers').replaceChildren()
  showSelection([], null)
  state.held = []
  state.found = null
  renderHeld()
  hideBanner()
}

/** The file the host handed this page (ctx.file): every file opens through the host (真源 §2.6). */
async function openHanded() {
  const token = { id: state.ctx.file.id }
  state.opening = token
  // A place is the file's its link names (#7257): another file opening drops it.
  if (state.place && state.place.file !== token.id) state.place = null
  closeCurrent()
  document.body.classList.add('show-doc')
  try {
    const file = await gugu.files.open(state.ctx.file)
    if (state.opening !== token) {
      file.close()
      return
    }
    // A stored file (a .json over a document's size is one): its details, to download — this App edits documents. The host
    // handed it to this App (it claims the name), so nobody else says why: this page does (复核 10-15).
    if (file.type === 'binary') {
      file.close()
      showDocMessage(state.t.downloadOnly)
      document.body.classList.add('binary', 'show-doc')
      $('doc-title').textContent = file.entry.name
      showEntry(file.entry)
      return
    }
    const current = { entry: file.entry, file, view: null, unbind: null, offs: [] }
    state.current = current
    bindFileMenu(current)
    showDoc(file.entry)
    watchStatus(current)
    watchPresence(current)
    if (file.type === 'text') await mountText(current, previewReady)
    else mountJson(current)
  } catch (error) {
    if (state.opening === token) showDocMessage(error.code === 'denied' ? state.t.denied : fmt(state.t.failed, { e: error.message }))
  } finally {
    if (state.opening === token) state.opening = null
  }
}

async function mountText(current, preview) {
  const prepared = await preview
  if ('error' in prepared) throw prepared.error
  const { md } = prepared
  if (state.current !== current) return
  const { file } = current
  document.body.dataset.kind = 'text'
  // Others' words (`chat`): raw HTML stays text, nothing loads; a relative link opens the file beside this one. Each
  // block says its lines (`sourceLines`): a selection there is cited by them, a pill's lines are found there.
  const render = () => {
    if (state.current !== current) return
    md.render($('preview'), file.text, { density: 'comfortable', frontmatter: true, sourceLines: true, file: current.entry })
    previewMarks()
  }
  const changed = debounce(render, 120)
  current.offs.push(file.onChange((event) => { if (!event.entry) changed() }))
  render()
  // Reading does not wait for the source editor's module and construction.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const cm = await editorKit()
  if (state.current !== current) return
  current.marks = lineMarks(cm)
  current.view = new cm.EditorView({
    parent: $('editor'),
    extensions: [cm.basicSetup, markdownSupport(cm), cm.EditorView.lineWrapping, editorTheme(cm), selectionWatch(cm), current.marks.extension],
  })
  current.unbind = gugu.bind.codemirror(current.view, file)
  showPlace()
}

// The selected text — in the editor (the source, each range of a multiple selection) or the preview — kept as it
// changes, with the lines it was written on and where it ends on screen: a small bar beside it offers Copy, Cite and
// ＋ Keep. On a phone the sandboxed page gets no native copy menu (WebView 133, L1), so Copy hands the text to the host
// (gugu.clipboard.writeText). Read at click time from here, because pressing a button may already have collapsed it.
let selectionEnd = null // () => the selection's end on screen, read again as the page scrolls
let picksInPreview = false

function showSelection(picks, end, inPreview = false) {
  state.picks = picks
  selectionEnd = picks.length ? end : null
  picksInPreview = inPreview && picks.length > 0
  document.body.classList.toggle('has-selection', picks.length > 0)
  // After the editor's update and the page's layout: reading positions inside an update is not allowed.
  requestAnimationFrame(placeSelectionBar)
}

function placeSelectionBar() {
  const bar = $('sel-bar')
  const at = selectionEnd?.()
  bar.hidden = !at || (!at.top && !at.bottom) // a pane that is not shown has no place on screen
  if (bar.hidden) return
  const gap = 6
  const below = at.bottom + gap + bar.offsetHeight <= window.innerHeight
  bar.style.top = `${below ? at.bottom + gap : Math.max(gap, at.top - gap - bar.offsetHeight)}px`
  bar.style.left = `${Math.max(gap, Math.min(at.left, window.innerWidth - bar.offsetWidth - gap))}px`
}

function selectionWatch(cm) {
  return cm.EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return
    const { doc, selection } = update.state
    const { view } = update
    // A range that ends at the start of a line does not take that line.
    const picks = selection.ranges.filter((range) => !range.empty).map(({ from, to }) => ({
      text: doc.sliceString(from, to),
      lines: [doc.lineAt(from).number, doc.lineAt(doc.lineAt(to).from === to ? to - 1 : to).number],
    }))
    showSelection(picks, () => (view.dom.isConnected ? view.coordsAtPos(selection.main.head) : null))
  })
}

// The preview's selection is the page's own; its lines are the ones its first and last block were written on.
document.addEventListener('selectionchange', () => {
  const picked = document.getSelection()
  if (picked && !picked.isCollapsed && $('preview').contains(picked.anchorNode)) {
    const range = picked.getRangeAt(picked.rangeCount - 1)
    const spanAt = (node) => spanOf((node.nodeType === 1 ? node : node.parentElement)?.closest('[data-line]')?.dataset.line)
    const [start, end] = [spanAt(range.startContainer), spanAt(range.endContainer)]
    const pick = { text: picked.toString(), lines: start && end ? [start[0], end[1]] : null }
    showSelection([pick], () => (range.endContainer.isConnected ? ([...range.getClientRects()].at(-1) ?? range.getBoundingClientRect()) : null), true)
  } else if (picksInPreview) {
    showSelection([], null)
  }
})
document.addEventListener('scroll', () => placeSelectionBar(), true)

// A place as the pill a cite makes (#7238): its lines (`at`: `{ lines, h }` — h finds them again once the file changes)
// and their words as a reader sees them (picked in the source or the preview alike); the file's name before them is gugu's. A
// preview block without lines names none: it points at the file, with its words.
function refOf(current, { text, lines }) {
  const words = plainWords(text)
  if (!lines) return { file: current.entry, label: words }
  const [first, last] = lines
  const label = `${fmt(first === last ? state.t.line : state.t.lines, { first, last })} · ${words}`
  return { file: current.entry, at: placeOf(current.file.text, first, last), label }
}

// Cite: the places kept (＋), then the selection's, each a pill into this chat's composer (a gugu.dispatch draft with refs) — the person
// says what to do with them, @s whom they like and sends it. A JSON file's view is not its text: its cite stays as it was,
// each range quoted with the lines it is shown on, and a pill to the file. Called inside the click, as a draft needs.
async function cite(current = state.current, picks = state.picks, held = state.held, whole = false) {
  if (!current || (!whole && !(held.length || picks.length))) return
  const quoted = ({ text, lines: [first, last] }) =>
    `${fmt(first === last ? state.t.line : state.t.lines, { first, last })}\n${text.replace(/\s+$/, '').split('\n').map((line) => `> ${line}`).join('\n')}`
  try {
    if (whole) await gugu.dispatch('', { draft: true, refs: [{ file: current.entry }] })
    else if (current.file.type === 'text') await gugu.dispatch('', { draft: true, refs: [...held, ...picks.map((pick) => refOf(current, pick))] })
    else await gugu.dispatch(picks.map(quoted).join('\n\n'), { draft: true, refs: [{ file: current.entry }] })
    state.held = []
    renderHeld()
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

// The shared content menu keeps the App's existing refs/line fingerprints and editor history.
function bindFileMenu(current) {
  for (const id of ['editor', 'preview']) {
    const root = $(id)
    root.dataset.guguFileViewer = crypto.randomUUID()
    let pending = null
    const receive = ({ detail }) => {
      if (detail.action === 'snapshot') {
        const picks = (id === 'editor' ? !picksInPreview : picksInPreview) ? [...state.picks] : []
        pending = { requestId: detail.requestId, picks, held: [...state.held], source: { entry: { ...current.entry }, file: { type: current.file.type, text: current.file.text } } }
        detail.selection = { text: picks.map(pick => pick.text).join('\n') }
        detail.editable = id === 'editor' && !!current.view && !current.view.state.readOnly
        if (detail.editable && current.file.type !== 'text') detail.editorHistory = { undo: state.cm.commands.undoDepth(current.view.state) > 0, redo: state.cm.commands.redoDepth(current.view.state) > 0 }
        detail.customSelectAll = id === 'editor'
      } else if (pending?.requestId === detail.requestId) {
        const captured = pending
        pending = null
        if (detail.action === 'select-all') {
          current.view?.dispatch({ selection: { anchor: 0, head: current.view.state.doc.length } })
          current.view?.focus()
        } else if (detail.action === 'undo' || detail.action === 'redo') {
          current.view?.focus()
          if (current.view && !current.view.state.readOnly) state.cm.commands[detail.action](current.view)
        } else if (detail.action === 'quote-selection' || detail.action === 'quote-file') {
          void cite(captured.source, captured.picks, captured.held, detail.action === 'quote-file')
        }
      }
    }
    root.addEventListener('gugu:file-viewer-menu', receive)
    current.offs.push(() => { root.removeEventListener('gugu:file-viewer-menu', receive); delete root.dataset.guguFileViewer })
  }
}

// ＋ Keep: the selection's places held for one Cite, marked where they are — a phone's Cite closes the file (演示稿's
// way of gathering, #7238), and a desktop's can gather across a long file.
function hold() {
  const current = state.current
  if (!current || !state.picks.length || current.file.type !== 'text') return
  state.held.push(...state.picks.map((pick) => refOf(current, pick)))
  document.getSelection()?.removeAllRanges()
  current.view?.dispatch({ selection: { anchor: current.view.state.selection.main.head } })
  renderHeld()
}

function renderHeld() {
  const n = state.held.length
  $('held-bar').hidden = n === 0
  $('held-count').textContent = fmt(state.t.held, { n, s: n === 1 ? '' : 's' })
  applyMarks()
}

// Lines marked in the source — the kept places, and the place a pill pointed at — as line decorations that follow edits.
function lineMarks(cm) {
  const { StateEffect, StateField } = cm.state
  const { Decoration } = cm.view
  const set = StateEffect.define()
  const decorate = (doc, spans) => Decoration.set(spans.flatMap(([first, last, cls]) => {
    const lines = []
    for (let n = first; n <= Math.min(last, doc.lines); n += 1) lines.push(Decoration.line({ class: cls }).range(doc.line(n).from))
    return lines
  }), true)
  const field = StateField.define({
    create: () => Decoration.none,
    update(marks, tr) {
      let next = marks.map(tr.changes)
      for (const effect of tr.effects) if (effect.is(set)) next = decorate(tr.state.doc, effect.value)
      return next
    },
    provide: (f) => cm.EditorView.decorations.from(f),
  })
  return { extension: field, set }
}

function applyMarks() {
  const current = state.current
  const kept = state.held.map((ref) => spanOf(ref.at?.lines)).filter(Boolean)
  const spans = [...kept.map(([a, b]) => [a, b, 'cm-held']), ...(state.found?.lines ? [[...state.found.lines, 'cm-found']] : [])]
  if (current?.view && current.marks) current.view.dispatch({ effects: current.marks.set.of(spans) })
  previewMarks()
}

/** The preview's blocks written on lines of `span` — the innermost (a list item, not its list as well). */
function blocksOn(span) {
  const over = (b) => { const s = spanOf(b.dataset.line); return s && span && s[0] <= span[1] && span[0] <= s[1] }
  const hits = [...$('preview').querySelectorAll('[data-line]')].filter(over)
  return hits.filter((b) => !hits.some((o) => o !== b && b.contains(o)))
}

function previewMarks() {
  const held = new Set(state.held.flatMap((ref) => blocksOn(spanOf(ref.at?.lines))))
  const found = new Set(blocksOn(state.found?.lines))
  for (const block of $('preview').querySelectorAll('[data-line]')) {
    block.classList.toggle('md-held', held.has(block))
    block.classList.toggle('md-found', found.has(block))
  }
}

// A pill opened this file (#7238: the `link` event a gugu link brings, `query` the pill's `at`): its lines, found again if
// the file has changed since (`relocate`), scrolled to and marked in the source and the preview until the next press.
// Held until that file's text is drawn: the link names its file (#7257: `link.file`).
function goTo(link) {
  state.place = { query: link.query, file: link.file }
  showPlace()
}

function showPlace() {
  const current = state.current
  if (!state.place || !current?.view || state.place.file !== current.entry.id) return
  const { lines, h, n } = state.place.query
  state.place = null
  const span = spanOf(lines)
  // A JSON file's view has no lines of its text.
  if (!span || current.file.type !== 'text') return
  const { doc } = current.view.state
  const found = h ? relocate(current.file.text, span, h, Number(n ?? 1)) : { first: span[0], last: span[1], moved: false }
  const at = found ? [found.first, found.last] : span.map((n) => Math.min(n, doc.lines))
  if (state.found?.said) hideBanner()
  state.found = { lines: found ? at : null, said: !found || found.moved }
  applyMarks()
  current.view.dispatch({ effects: state.cm.EditorView.scrollIntoView(doc.line(at[0]).from, { y: 'center' }) })
  blocksOn(at)[0]?.scrollIntoView?.({ block: 'center' })
  // Said until the next press on the file, as the mark stays (the file's status coming in does not take it away).
  if (found?.moved) showBanner(fmt(state.t.placeMoved, { lines: fmt(at[0] === at[1] ? state.t.line : state.t.lines, { first: at[0], last: at[1] }) }), 'info', true)
  else if (!found) showBanner(state.t.placeGone, 'info', true)
}

async function copySelection() {
  const text = state.picks.map((pick) => pick.text).join('\n')
  if (!text) return
  const button = $('copy-sel')
  try {
    await gugu.clipboard.writeText(text)
    button.textContent = state.t.copied
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
  setTimeout(() => {
    button.textContent = state.t.copy
  }, 1200)
}

function editorTheme(cm) {
  return cm.EditorView.theme({
    '&': { height: '100%', color: 'var(--em-foreground)', backgroundColor: 'transparent' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--em-foreground-muted)', border: 'none' },
    '&.cm-focused': { outline: 'none' },
  })
}

// JSON files are live objects in the open file (a Y.Map), not text: they are shown as indented text,
// edited as text, and applied key by key — only the keys this person changed are written, so a key
// someone else changed meanwhile keeps their value (same key: last writer wins, as the API says).
function mountJson(current) {
  const { file } = current
  document.body.dataset.kind = 'json'
  const pretty = () => JSON.stringify(file.toJSON(), null, 2)
  editorKit().then((cm) => {
    if (state.current !== current) return
    let base = file.toJSON()
    let dirty = false
    // Update listeners run inside dispatch, so a flag set around our own reload tells it from typing.
    let reloading = false
    const view = new cm.EditorView({
      parent: $('editor'),
      doc: pretty(),
      extensions: [
        cm.basicSetup,
        cm.json(),
        cm.EditorView.lineWrapping,
        editorTheme(cm),
        selectionWatch(cm),
        cm.EditorState.readOnly.of(file.readOnly),
        cm.EditorView.updateListener.of((update) => {
          if (!update.docChanged || reloading) return
          dirty = true
          document.body.classList.add('json-dirty')
        }),
      ],
    })
    current.view = view
    const load = () => {
      base = file.toJSON()
      reloading = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pretty() } })
      } finally {
        reloading = false
      }
      dirty = false
      document.body.classList.remove('json-dirty')
      hideBanner()
    }
    current.offs.push(file.onChange(({ local, entry }) => {
      if (local || entry) return
      if (dirty) showBanner(state.t.jsonRemote, 'info')
      else load()
    }))
    current.jsonApply = () => {
      let next
      try {
        next = JSON.parse(view.state.doc.toString())
      } catch (error) {
        showBanner(fmt(state.t.jsonInvalid, { e: error.message }), 'error')
        return
      }
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        showBanner(state.t.jsonNotObject, 'error')
        return
      }
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      file.transact(() => {
        for (const key of Object.keys(base)) if (!(key in next)) file.data[key] = undefined
        for (const [key, value] of Object.entries(next)) if (!same(base[key], value)) file.data[key] = value
      })
      load()
    }
    current.jsonDiscard = load
  })
}
function watchStatus(current) {
  const { file } = current
  current.offs.push(file.onChange((event) => {
    if (!event.entry || state.current !== current || !current.entry.detailsPending) return
    current.entry = file.entry
    state.shown = current.entry
    renderDocInfo(current.entry)
  }))
  const show = (status) => {
    if (state.current !== current) return
    const t = state.t
    const badge = $('doc-status')
    badge.dataset.status = status
    badge.textContent = file.readOnly && status === 'online' ? t.readOnly : status === 'offline' ? t.offline : ''
    if (status === 'gone') goneState(current)
    else if (status === 'offline') showBanner(t.offline, 'info')
    else if (!$('banner').dataset.sticky) hideBanner()
  }
  // Ordinary edits and their confirmations stay quiet; read-only and offline still need saying.
  current.offs.push(file.onStatus(show))
  // A refused change (too large, rate-limited) is the runtime's to say, for every App alike (A6).
  show(file.status)
}

// Gone: deleted, removed from the chat, capability withdrawn. The text stays readable; editing stops.
function goneState(current) {
  showBanner(state.t.gone, 'error', true)
  const text = current.file.type === 'text' ? current.file.text : JSON.stringify(current.file.toJSON(), null, 2)
  current.unbind?.()
  current.unbind = null
  current.view?.destroy()
  const cm = state.cm
  if (cm) {
    current.view = new cm.EditorView({
      parent: $('editor'),
      doc: text,
      extensions: [cm.basicSetup, current.file.type === 'text' ? markdownSupport(cm) : cm.json(), cm.EditorView.lineWrapping, editorTheme(cm), selectionWatch(cm), cm.EditorState.readOnly.of(true), cm.EditorView.editable.of(false)],
    })
  }
  document.body.classList.add('gone')
  refreshList()
}

function watchPresence(current) {
  const render = (others) => {
    if (state.current !== current) return
    const chips = others.map((peer) => {
      const chip = document.createElement('span')
      chip.className = 'peer'
      chip.style.setProperty('--peer', peer.color)
      chip.textContent = peer.name || peer.userId.slice(0, 6)
      chip.title = peer.name || peer.userId
      return chip
    })
    $('peers').replaceChildren(...chips)
  }
  current.offs.push(current.file.presence.onChange(render))
  render(current.file.presence.others)
}

// ─── panes and messages ─────────────────────────────────────────────────────

function showDoc(entry) {
  document.body.classList.remove('gone', 'json-dirty', 'binary')
  document.body.dataset.state = 'doc'
  $('doc-title').textContent = entry.name
  $('doc-message').hidden = true
  showEntry(entry)
}

function showDocMessage(message) {
  document.body.dataset.state = 'message'
  $('doc-title').textContent = ''
  $('doc-status').textContent = ''
  $('doc-message').hidden = false
  $('doc-message').textContent = message
  showEntry(null)
}

function showEntry(entry) {
  state.shown = entry
  renderChrome()
  $('download').hidden = !entry
  $('open-with').hidden = !entry
  $('more').hidden = !entry
  closeMenu()
  renderDocInfo(entry?.detailsPending ? null : entry)
}

// Under the header: creation, editing, and the messages the file came from. The App cannot read those
// messages (D-22); a click asks the host to show one in its chat (gugu.showMessage).
function renderDocInfo(entry) {
  const t = state.t
  const parts = []
  const activity = activityOf(entry).join(' · ')
  if (activity) parts.push(Object.assign(document.createElement('span'), { className: 'file-activity', textContent: activity, title: activity }))
  const sources = entry?.sourceMessageIds ?? []
  if (sources.length) {
    const box = document.createElement('span')
    box.className = 'sources'
    box.append(`${t.sources}:`)
    sources.forEach((id, i) => {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'source'
      link.dataset.messageId = id
      link.textContent = fmt(t.source, { n: i + 1 })
      link.onclick = () =>
        gugu.showMessage(id).catch((error) => showBanner(error.code === 'not-found' ? t.sourceGone : fmt(t.failed, { e: error.message }), 'error'))
      box.append(link)
    })
    parts.push(box)
  }
  $('doc-info').replaceChildren(...parts)
  $('doc-info').hidden = parts.length === 0
}

// Said on the page the person is on (F32: one page at a time) — the file's line on the file, the list's own line on the
// list: the list page does not draw the file's pane, its line included.
function showBanner(message, tone, sticky = false) {
  const banner = document.body.classList.contains('show-doc') || document.body.classList.contains('no-list') ? $('banner') : $('list-banner')
  banner.hidden = false
  banner.dataset.tone = tone
  if (sticky) banner.dataset.sticky = '1'
  else delete banner.dataset.sticky
  banner.textContent = message
}

function hideBanner() {
  for (const banner of [$('banner'), $('list-banner')]) {
    banner.hidden = true
    delete banner.dataset.sticky
  }
}

// Side by side needs room (style.css hides its button when narrow): there the choice is Source or Preview, and a
// person who chose side by side reads the preview until the pane is wide again (主人 10-01).
const narrowPane = window.matchMedia?.('(max-width: 640px)') ?? null

function setMode(mode) {
  state.mode = mode
  applyMode()
}

function applyMode() {
  const mode = narrowPane?.matches && state.mode === 'split' ? 'preview' : state.mode
  document.body.dataset.mode = mode
  for (const m of ['edit', 'split', 'preview']) $(`mode-${m}`).setAttribute('aria-selected', String(m === mode))
}

// The page's one menu (#menu): a row's ⋯, and the open file's ⋯ when narrow. Under the ⋯ that opened it, above when there
// is no room below; a press elsewhere, Escape, a scroll or a resize closes it, and so does choosing an item. An item that
// asks first (`ask`: Delete, in red) only says its question on the first press; the items are made anew on every open,
// so closing the menu takes the question back. The keyboard goes with it: in on the first item, back to the ⋯ on close.
function toggleMenu(anchor, items) {
  const again = state.menuAnchor === anchor
  closeMenu()
  if (again) return
  const menu = $('menu')
  menu.replaceChildren(...items.map(([text, onclick, ask]) => {
    const item = document.createElement('button')
    item.type = 'button'
    if (ask) item.className = 'destructive'
    item.setAttribute('role', 'menuitem')
    item.textContent = text
    item.onclick = () => {
      if (ask && item.textContent !== ask) return void (item.textContent = ask)
      closeMenu()
      onclick()
    }
    return item
  }))
  state.menuAnchor = anchor
  anchor.setAttribute('aria-expanded', 'true')
  menu.hidden = false
  const box = anchor.getBoundingClientRect()
  const below = box.bottom + 4 + menu.offsetHeight <= innerHeight - 8
  menu.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - menu.offsetHeight)}px`
  menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`
  menu.firstElementChild.focus({ preventScroll: true })
}

function closeMenu() {
  if ($('menu').contains(document.activeElement)) state.menuAnchor?.focus({ preventScroll: true })
  state.menuAnchor?.setAttribute('aria-expanded', 'false')
  state.menuAnchor = null
  $('menu').hidden = true
}

// ─── start ──────────────────────────────────────────────────────────────────

function start() {
  $('filter').oninput = (event) => {
    state.filter = event.target.value
    renderList()
  }
  $('new-doc').onclick = () => toggleMenu($('new-doc'), [[state.t.newDoc, createDoc], [state.t.newFolder, createFolder]])
  $('upload').onclick = $('empty-upload').onclick = () => uploadFiles()
  $('move-cancel').onclick = closeMoveDialog
  $('move-dialog').addEventListener('pointerdown', (event) => {
    if (event.target === $('move-dialog')) closeMoveDialog()
  })
  $('conflicts-done').onclick = () => ($('conflicts').hidden = true)
  $('download').onclick = () => downloadShown()
  $('open-with').onclick = () => {
    if (state.shown) openInHost(state.shown, true)
  }
  // The same menu at every width; the wide pane also keeps its Download and Open with shortcuts.
  $('more').onclick = () => {
    const items = [[state.t.download, downloadShown], [state.t.openWith, () => openInHost(state.shown, true)]]
    if (canWrite() && state.shown && !state.shown.systemRole && !state.current?.file.readOnly) items.push([state.t.rename, () => startRename($('doc-title'), state.shown)])
    toggleMenu($('more'), items)
  }
  document.addEventListener('pointerdown', (event) => {
    if (state.menuAnchor && !$('menu').contains(event.target) && !state.menuAnchor.contains(event.target)) closeMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    closeMenu()
    if (!$('move-dialog').hidden) closeMoveDialog()
  })
  // Tabbing out of the menu closes it too (past its last item the focus leaves the page, and Escape with it); a move
  // to its own ⋯ is left to that ⋯'s click, which toggles.
  $('menu').addEventListener('focusout', (event) => {
    if (!$('menu').contains(event.relatedTarget) && event.relatedTarget !== state.menuAnchor) closeMenu()
  })
  // The menu stays where its ⋯ was: a scroll (the list's too, captured) or a resize moves the ⋯ away from it.
  document.addEventListener('scroll', () => closeMenu(), true)
  window.addEventListener('resize', () => closeMenu())
  narrowPane?.addEventListener?.('change', applyMode)
  for (const mode of ['edit', 'split', 'preview']) $(`mode-${mode}`).onclick = () => setMode(mode)
  $('json-apply').onclick = () => state.current?.jsonApply?.()
  $('json-discard').onclick = () => state.current?.jsonDiscard?.()
  // Keep the editor's focus and selection when the button is pressed; copy inside the click (a user gesture).
  $('copy-sel').addEventListener('pointerdown', (event) => event.preventDefault())
  $('copy-sel').onclick = () => copySelection()
  for (const id of ['cite-sel', 'hold-sel', 'held-cite']) $(id).addEventListener('pointerdown', (event) => event.preventDefault())
  $('cite-sel').onclick = () => cite()
  $('hold-sel').onclick = () => hold()
  $('held-cite').onclick = () => cite()
  $('held-clear').onclick = () => {
    state.held = []
    renderHeld()
  }
  // A pill's place stays marked, and what was said of it, until the next press on the file.
  for (const id of ['editor', 'preview']) {
    $(id).addEventListener('pointerdown', () => {
      if (!state.found) return
      if (state.found.said) hideBanner()
      state.found = null
      applyMarks()
    })
  }
  gugu.onLink(goTo)
  setMode(state.mode)
  const contextFailed = (error) => showDocMessage(fmt(state.t.failed, { e: error.message }))
  gugu.onContextChanged((ctx) => applyContext(ctx).catch(contextFailed))
  gugu.getContext().then(applyContext).catch(contextFailed)
}

start()
