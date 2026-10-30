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
import { KINDS, SORTS, compareNames, comparer, defaultView, keepable, keptAs, kindOf, markOf, matches, rangeOf, sectionOf, sizeOf, timeLeft, wantsThumb } from './list.js'

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
    showAppData: '显示 App 数据',
    hideAppData: '隐藏 App 数据',
    newFolder: '新建文件夹',
    newFolderName: '新建文件夹',
    attachments: '附件',
    machineOf: '{owner} 的机器',
    storedOnMine: '保存在 {machine} 上，有人打开时才上传。按你在「设置 › 设备 › 文件存储与读取」里的设置。',
    storedOnOther: '保存在 {owner} 的机器上，有人打开时才上传。按 {owner} 的文件存储设置。',
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
    edit: '编辑',
    split: '对照',
    preview: '阅读',
    bold: '加粗',
    italic: '斜体',
    code: '代码',
    link: '链接',
    block: '这一段',
    citeBlock: '引用到聊天',
    holdBlock: '加入待引用',
    copyBlockLink: '复制这一段的链接',
    findSource: '在源码里定位',
    linkCopied: '已复制这一段的链接',
    emptyTitle: '这份文档还是空的',
    emptyHint: '直接开始写，或者请 agent 起个草稿',
    emptyWrite: '开始写',
    emptyDraft: '请 agent 起草',
    emptyAsk: '帮我起草这份文档，内容：',
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
    kind_all: '全部',
    kind_docs: '文档',
    kind_media: '图片和视频',
    kind_other: '其他',
    kinds: '按类型',
    sort: '排序',
    sort_recent: '最近',
    sort_name: '名称',
    sort_size: '大小',
    folders: '文件夹',
    files: '文件',
    today: '今天',
    yesterday: '昨天',
    week: '过去 7 天',
    earlier: '更早',
    noKind: '这里没有这一类的文件。',
    leftDays: '临时 · {n} 天',
    leftHours: '临时 · {n} 小时',
    leftMinutes: '临时 · {n} 分钟',
    clearsAt: '{time} 清除云端副本',
    keep: '保留方式',
    keepTemporary: '临时',
    keepPermanent: '一直保留',
    keepTip: '临时：到期清除云端副本，期限按上传者在「设置 › 设备 › 文件存储」里的设置，从改的这一刻算起。一直保留：直到有人删除。',
    keepNotMine: '只有上传这份文件的人能改它保留多久。',
    keepNone: '这份文件没有云端副本。',
    showInChat: '在聊天中定位',
    copyLink: '复制链接',
    linkCopied: '链接已复制',
    views: '显示方式',
    view_list: '列表',
    view_grid: '网格',
    filter_who: '上传者',
    filter_where: '存放',
    filter_keep: '保留方式',
    anyone: '全部',
    cloud: '云端',
    keep_temporary: '临时',
    keep_kept: '一直保留',
    keep_soon: '7 天内清除',
    clearFilters: '清除筛选',
    noFiltered: '没有符合条件的文件。',
    details: '详情',
    open: '打开',
    close: '关闭',
    col_name: '名称',
    col_when: '修改时间',
    col_size: '大小',
    d_size: '大小',
    d_by: '上传',
    d_edited: '改动',
    d_where: '位置',
    d_stored: '存放',
    d_keep: '保留',
    d_versions: '版本',
    d_version: '第 {n} 版',
    noCopy: '没有云端副本',
    machineOnline: '在线',
    machineOffline: '离线',
    hostOffline: '{machine} 离线，上线后才能打开这个文件。',
    pick: '选择',
    pickAll: '全选',
    pickDone: '完成',
    picked: '已选 {n} 项',
    pickCancel: '取消选择',
    pickDownload: '下载',
    pickTemporary: '设为临时',
    pickPermanent: '一直保留',
    pickLocate: '在聊天中定位',
    pickLocateAt: '{i}/{n}',
    pickPrev: '上一条',
    pickNext: '下一条',
    savedFiles: '已保存 {n} 个文件。',
    keptFiles: '已改 {n} 个。',
    skippedNotMine: '{n} 个不是你上传的，没改。',
    skippedNoCopy: '{n} 个没有云端副本，没改。',
    noSources: '选中的文件都不是从聊天里来的。',
  },
  en: {
    groupFolder: 'Group folder',
    folder: 'Folder',
    title: '{folder}',
    filter: 'Filter by name',
    new: 'New',
    newDoc: 'New document',
    newName: 'Untitled.md',
    showAppData: 'Show App data',
    hideAppData: 'Hide App data',
    newFolder: 'New folder',
    newFolderName: 'New folder',
    attachments: 'Attachments',
    machineOf: '{owner}’s machine',
    storedOnMine: 'Kept on {machine}; uploaded only when someone opens it. Follows your Settings › Devices › File storage.',
    storedOnOther: 'Kept on {owner}’s machine; uploaded only when someone opens it. Follows {owner}’s file storage settings.',
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
    edit: 'Edit',
    split: 'Side by side',
    preview: 'Read',
    bold: 'Bold',
    italic: 'Italic',
    code: 'Code',
    link: 'Link',
    block: 'This block',
    citeBlock: 'Cite in the chat',
    holdBlock: 'Keep to cite',
    copyBlockLink: 'Copy a link to it',
    findSource: 'Find in the source',
    linkCopied: 'Link copied',
    emptyTitle: 'This document is empty',
    emptyHint: 'Start writing, or ask an agent for a draft',
    emptyWrite: 'Start writing',
    emptyDraft: 'Ask an agent',
    emptyAsk: 'Draft this document for me: ',
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
    kind_all: 'All',
    kind_docs: 'Docs',
    kind_media: 'Images & videos',
    kind_other: 'Other',
    kinds: 'By kind',
    sort: 'Sort',
    sort_recent: 'Recent',
    sort_name: 'Name',
    sort_size: 'Size',
    folders: 'Folders',
    files: 'Files',
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'Past 7 days',
    earlier: 'Earlier',
    noKind: 'No files of this kind here.',
    leftDays: 'Temporary · {n}d',
    leftHours: 'Temporary · {n}h',
    leftMinutes: 'Temporary · {n}m',
    clearsAt: 'Cloud copy cleared {time}',
    keep: 'Keep',
    keepTemporary: 'Temporary',
    keepPermanent: 'Until deleted',
    keepTip: 'Temporary: the cloud copy is cleared after the uploader\'s period in Settings › Devices › File storage, counted from now. Until deleted: kept until someone deletes it.',
    keepNotMine: 'Only the person who uploaded this file can change how long it is kept.',
    keepNone: 'This file has no cloud copy.',
    showInChat: 'Show in chat',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    views: 'View',
    view_list: 'List',
    view_grid: 'Grid',
    filter_who: 'Uploaded by',
    filter_where: 'Kept on',
    filter_keep: 'Keep',
    anyone: 'Any',
    cloud: 'Cloud',
    keep_temporary: 'Temporary',
    keep_kept: 'Until deleted',
    keep_soon: 'Cleared within 7 days',
    clearFilters: 'Clear filters',
    noFiltered: 'No file matches these filters.',
    details: 'Details',
    open: 'Open',
    close: 'Close',
    col_name: 'Name',
    col_when: 'Modified',
    col_size: 'Size',
    d_size: 'Size',
    d_by: 'Uploaded',
    d_edited: 'Changed',
    d_where: 'Location',
    d_stored: 'Kept on',
    d_keep: 'Keep',
    d_versions: 'Versions',
    d_version: 'Version {n}',
    noCopy: 'No cloud copy',
    machineOnline: 'online',
    machineOffline: 'offline',
    hostOffline: '{machine} is offline: this file opens once it is back.',
    pick: 'Select',
    pickAll: 'Select all',
    pickDone: 'Done',
    picked: '{n} selected',
    pickCancel: 'Clear selection',
    pickDownload: 'Download',
    pickTemporary: 'Make temporary',
    pickPermanent: 'Keep until deleted',
    pickLocate: 'Show in chat',
    pickLocateAt: '{i}/{n}',
    pickPrev: 'Previous',
    pickNext: 'Next',
    savedFiles: '{n} files saved.',
    keptFiles: '{n} changed.',
    skippedNotMine: '{n} not uploaded by you, left as they are.',
    skippedNoCopy: '{n} without a cloud copy, left as they are.',
    noSources: 'None of these files came from the chat.',
  },
}

const state = {
  ctx: null,
  t: stringsFor('zh', null),
  entries: [],
  listError: null,
  filter: '',
  // The kind of file the list shows and its order (list.js), as this person last left them on this device.
  kind: remembered('kind', KINDS, 'all'),
  sort: remembered('sort', SORTS, 'recent'),
  // The filters (上传者 / 存放 / 保留方式), each null for any: not kept — a folder opened later shows all its files.
  filters: { who: null, where: null, keep: null },
  details: null, // the entry whose details are open
  ofKind: [], // the files of the kind picked in the list last drawn: what the filters offer to pick by
  picked: new Set(), // 多选: the ids of the files picked, on screen
  selecting: false, // the phone's explicit selection mode, including an empty selection
  pickFrom: null, // the file pressed last, where a Shift press's range starts
  order: [], // the files on screen, in their order: what a range runs along
  locating: null, // 「在聊天中定位」 for a selection: { ids: message ids oldest first, at }
  showAppData: false,
  folder: null, // the folder the list shows (子文件夹): a folder entry's id, null for the top
  dragging: null, // the entry being dragged onto a folder (desktop)
  mode: 'preview', // 阅读 first (owner 10-30, folder-docs)
  current: null, // { entry, file, view, unbind, offs: [] }
  opening: null,
  cm: null,
  md: null,
  picks: [], // the selection: { text, lines: [first, last] | null } per range (several, with Ctrl / Cmd in the source)
  held: [], // places kept with ＋ (refs), cited with the selection's
  listing: null, // the list asked last, on its way: { heard: [changes said meanwhile] }
  place: null, // { query: a pill's `at`, file: the file its link names }, waiting for that file's text to be drawn
  found: null, // what a pill's place showed, until the next press: { lines: [first, last] marked or null, said: in the banner }
  menuAnchor: null, // the control whose menu is open
  shown: null, // the entry on screen, text/JSON or binary: what Download saves
  titled: null, // the title last given to the host (setTabTitle)
}

// A choice of this page's kept on this device (the App's own storage): the one asked for when it is still one of `choices`.
function remembered(key, choices, fallback) {
  try {
    const value = localStorage.getItem(`workspace.${key}`)
    return choices.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(`workspace.${key}`, value)
  } catch { /* a page without storage forgets */ }
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

// A leading `---` block is the file's front matter, as the preview reads it: one quiet block, not the setext heading
// lezer's markdown makes of `key: value` above the closing `---`.
function frontmatterBlock(cm) {
  return {
    defineNodes: [{ name: 'Frontmatter', block: true, style: cm.lezerHighlight.tags.meta }],
    parseBlock: [{
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false
        while (cx.nextLine()) {
          if (/^---\s*$/.test(line.text)) {
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd()))
        return true
      },
    }],
  }
}

// GFM (tables, strikethrough, task items), and front matter.
function markdownSupport(cm) {
  return cm.markdown({ base: cm.markdownLanguage, extensions: [frontmatterBlock(cm)] })
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
    if (inGroup && canRead() && !ctx.file) {
      state.showAppData = false
      await refreshList(true)
    }
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
  $('select-files').textContent = state.selecting || state.picked.size ? t.pickDone : t.pick
  renderTools()
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
  for (const fmt of ['bold', 'italic', 'code', 'link']) {
    $(`fmt-${fmt}`).setAttribute('aria-label', t[fmt])
    $(`fmt-${fmt}`).title = t[fmt]
  }
  $('block-handle').setAttribute('aria-label', t.block)
  $('doc-empty-title').textContent = t.emptyTitle
  $('doc-empty-hint').textContent = t.emptyHint
  $('empty-write-label').textContent = t.emptyWrite
  $('empty-draft-label').textContent = t.emptyDraft
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
async function refreshList(readPreferences = false) {
  if (!state.ctx?.chat || !canRead()) return
  const asked = (state.listing = { heard: [] })
  let entries
  let listError = null
  try {
    const place = { chat: state.ctx.chat.id }
    const [listed, preferences] = await Promise.all([
      gugu.files.list(place),
      readPreferences ? gugu.files.viewPreferences(place) : null,
    ])
    entries = listed
    if (state.listing === asked && preferences) state.showAppData = preferences.showAppData
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
  if (take(change)) keepLater()
  showList()
}

// A change is read one file at a time, which does not say how long a cloud copy is kept (`keep`, the list's): the list's
// answer stays until the list is read again. A file new to the list has none to keep — true when the list says it
// (the host's list carries `keep`), so the list is read again for it.
function take(change) {
  const before = new Map(state.entries.map((entry) => [entry.id, entry]))
  const listsKeep = state.entries.some((entry) => 'keep' in entry)
  const fresh = new Map(change.entries.map((entry) => [entry.id, 'keep' in entry || !before.has(entry.id) || !('keep' in before.get(entry.id)) ? entry : { ...entry, keep: before.get(entry.id).keep }]))
  state.entries = [...state.entries.filter((entry) => !fresh.has(entry.id) && !change.gone.includes(entry.id)), ...fresh.values()]
  return listsKeep && [...fresh.values()].some((entry) => !('keep' in entry) && entry.type !== 'folder')
}

// Several files arriving together (an upload of ten) are one read of the list, a moment after the last.
const keepLater = debounce(() => void refreshList(), 800)

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
// Ownership is explicitly stored on the item. Opener claims and names do not classify App data.
function visibleEntry(entry) {
  const app = entry.metadata?.app
  const marked = app && typeof app.publisher === 'string' && app.publisher.trim() && typeof app.id === 'string' && app.id.trim()
  return state.showAppData || !marked
}

async function folderContextMenu(x, y) {
  if (!state.ctx?.chat || state.ctx.file || !canRead()) return
  const chat = state.ctx.chat.id
  const show = !state.showAppData
  try {
    const action = await gugu.showContextMenu({ x, y, items: [{ id: 'app-data', label: state.showAppData ? state.t.hideAppData : state.t.showAppData }] })
    if (action !== 'app-data' || state.ctx?.chat?.id !== chat) return
    const preference = await gugu.files.viewPreferences({ chat }, { showAppData: show })
    if (state.ctx?.chat?.id !== chat) return
    state.showAppData = preference.showAppData
    renderList()
  } catch (error) { showBanner(fmt(state.t.failed, { e: error.message }), 'error') }
}
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

// What the top of the folder shows (owner 10-28): its folders, and every file there or in 「附件」 — what was sent in the
// chat is not one folder further down. 「附件」 itself is not a row; it is still a folder a file can be moved to.
function topEntries() {
  const attachments = inside(null).filter((e) => e.systemRole === 'attachments')
  return [...inside(null).filter((e) => e.systemRole !== 'attachments'), ...attachments.flatMap((folder) => under(folder.id))]
}

// The folders of a list: 「附件」 first where a search lists it, the rest by name.
function folderOrder(a, b) {
  if (!!a.systemRole !== !!b.systemRole) return a.systemRole ? -1 : 1
  return compareNames(a, b, shownName, state.ctx?.locale)
}

// One list, one scroll: the folder on screen (子文件夹) — or, while filtering, every file whose name matches, wherever it
// is. Folders first, then the files of the kind picked and the filters set, in the order picked; by time, under today /
// yesterday / the past week / each month. As rows (a table when the pane is wide) or, for images and videos, a grid.
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
  // One clock for the whole list, the one relative times read (Date.now).
  const now = new Date(Date.now())
  const shown = (needle ? state.entries : state.folder ? inside(state.folder) : topEntries())
    .filter(visibleEntry)
    .filter((e) => !needle || e.name.toLocaleLowerCase().includes(needle) || shownName(e).toLocaleLowerCase().includes(needle))
  const ofKind = (state.ofKind = shown.filter((e) => !isFolder(e) && (state.kind === 'all' || kindOf(e) === state.kind)))
  renderTools(ofKind, now)
  const filtering = Object.values(state.filters).some(Boolean)
  const folders = state.kind === 'all' && !filtering ? shown.filter(isFolder).sort(folderOrder) : []
  const files = ofKind.filter((e) => matches(e, state.filters, machineOf, now)).sort(comparer(state.sort, shownName, changedAt, state.ctx?.locale))
  const grid = viewOf(state.kind) === 'grid'
  list.classList.toggle('as-grid', grid)
  const item = (entry) => (grid && !isFolder(entry) ? gridItem(entry, now) : listItem(entry, now))
  const rows = []
  if (!grid && (folders.length || files.length)) rows.push(tableHead())
  if (folders.length && files.length) rows.push(sectionRow(t.folders))
  rows.push(...folders.map(item))
  let section = null
  for (const entry of files) {
    if (state.sort === 'recent') {
      const at = sectionOf(changedAt(entry), now)
      if (at.key !== section?.key) rows.push(sectionRow(sectionName(at)))
      section = at
    } else if (!section && folders.length) {
      section = { key: 'files' }
      rows.push(sectionRow(t.files))
    }
    rows.push(item(entry))
  }
  list.replaceChildren(...rows)
  // 多选: what is picked stays picked while it is on screen; the order a range runs along is the order drawn.
  state.order = files.map((e) => e.id)
  for (const id of state.picked) if (!state.order.includes(id)) state.picked.delete(id)
  renderPicks()
  // A row's menu goes with its row (the list is drawn anew when the workspace changes).
  if (state.menuAnchor && !state.menuAnchor.isConnected) closeMenu()
  if (state.details) {
    const fresh = state.entries.find((e) => e.id === state.details.id)
    if (fresh) showDetails(fresh)
    else closeDetails()
  }
  const count = folders.length + files.length
  empty.hidden = count > 0
  $('files-empty-message').textContent = state.listError
    ?? (needle ? fmt(t.noMatch, { q: state.filter.trim() }) : filtering && ofKind.length ? t.noFiltered
      : state.kind !== 'all' && shown.length ? t.noKind : state.folder ? t.folderEmpty : t.noFiles)
  $('empty-upload').hidden = !canWrite() || !!needle || !!state.listError || (state.kind !== 'all' && shown.length > 0) || filtering
}

function sectionRow(text) {
  const li = document.createElement('li')
  li.className = 'list-section'
  li.setAttribute('role', 'presentation')
  li.textContent = text
  return li
}

function sectionName(section) {
  const t = state.t
  if (section.kind !== 'month') return t[section.kind]
  return new Intl.DateTimeFormat(state.ctx?.locale || 'en', { year: 'numeric', month: 'long' }).format(new Date(section.year, section.month - 1, 1))
}

// The table's head (drawn only where the pane is wide, style.css): its columns, the sortable ones a press away.
function tableHead() {
  const t = state.t
  const li = document.createElement('li')
  li.className = 'table-head'
  li.setAttribute('role', 'presentation')
  const column = (cell, text, sort) => {
    const head = document.createElement(sort ? 'button' : 'span')
    head.dataset.cell = cell
    head.textContent = text
    if (sort) {
      head.type = 'button'
      if (state.sort === sort) head.setAttribute('aria-current', 'true')
      head.onclick = () => setSort(sort)
    }
    return head
  }
  const all = Object.assign(document.createElement('button'), { type: 'button', className: 'pick-all' })
  all.setAttribute('role', 'checkbox')
  all.setAttribute('aria-label', t.pickAll)
  all.onclick = () => pickAll()
  li.append(all, column('name', t.col_name, 'name'), column('when', t.col_when, 'recent'), column('size', t.col_size, 'size'))
  return li
}

// The way a kind is shown (list or grid), as the person last left it on this device; images and videos open as a grid.
function viewOf(kind) {
  return remembered(`view.${kind}`, ['list', 'grid'], defaultView(kind))
}

// What the 「存放」 filter calls the machine a project file stays on.
function machineOf(storedOn) {
  return storedOn.machine ?? fmt(state.t.machineOf, { owner: storedOn.owner })
}

// The kinds (全部 / 文档 / 图片和视频 / 其他), the order and the view, above the list (kept on this device); under them the
// filters this list has something to pick by (上传者; 存放 where a file stays on a machine; 保留方式 where one has a cloud copy).
function renderTools(files = state.ofKind, now = new Date(Date.now())) {
  const t = state.t
  const kinds = $('kinds')
  if (kinds.childElementCount !== KINDS.length) {
    kinds.replaceChildren(...KINDS.map((kind) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.kind = kind
      button.onclick = () => {
        clearPicks()
        state.kind = kind
        remember('kind', kind)
        renderList()
        $('file-list').scrollTop = 0
      }
      return button
    }))
  }
  kinds.setAttribute('aria-label', t.kinds)
  for (const button of kinds.children) {
    button.textContent = t[`kind_${button.dataset.kind}`]
    button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind))
  }
  $('sort-label').textContent = t[`sort_${state.sort}`]
  $('sort').title = t.sort
  $('sort').setAttribute('aria-label', `${t.sort}: ${t[`sort_${state.sort}`]}`)
  $('views').setAttribute('aria-label', t.views)
  for (const button of $('views').children) {
    const label = t[`view_${button.dataset.view}`]
    button.title = label
    button.setAttribute('aria-label', label)
    button.setAttribute('aria-pressed', String(viewOf(state.kind) === button.dataset.view))
  }
  renderChips(files, now)
}

// One chip per filter there is something to pick by; a set one says what it is set to.
function renderChips(files, now) {
  const t = state.t
  const people = new Map()
  for (const entry of files) if (entry.createdBy && entry.createdBy.kind !== 'system' && entry.createdBy.id) people.set(entry.createdBy.id, entry.createdBy)
  const machines = [...new Set(files.filter((e) => e.storedOn).map((e) => machineOf(e.storedOn)))]
  const kept = new Set(files.map((e) => keptAs(e, now)).filter(Boolean))
  const options = {
    who: people.size > 1 || state.filters.who ? [...people.values()].map((person) => [person.id, who(person)]) : [],
    where: machines.length || state.filters.where ? [['cloud', t.cloud], ...machines.map((name) => [name, name])] : [],
    keep: kept.size || state.filters.keep ? [['temporary', t.keep_temporary], ['soon', t.keep_soon], ['kept', t.keep_kept]] : [],
  }
  const chips = []
  for (const key of ['who', 'where', 'keep']) {
    if (!options[key].length) continue
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip'
    chip.dataset.filter = key
    chip.setAttribute('aria-haspopup', 'menu')
    const set = state.filters[key]
    const label = set ? options[key].find(([value]) => value === set)?.[1] ?? set : null
    chip.textContent = label ? `${t[`filter_${key}`]}: ${label}` : t[`filter_${key}`]
    if (set) chip.setAttribute('aria-pressed', 'true')
    chip.onclick = () => toggleMenu(chip, [[null, t.anyone], ...options[key]].map(([value, text]) => ({
      text, checked: (state.filters[key] ?? null) === value, run: () => setFilter(key, value),
    })))
    chips.push(chip)
  }
  if (Object.values(state.filters).some(Boolean)) {
    const clear = Object.assign(document.createElement('button'), { type: 'button', className: 'chips-clear', textContent: t.clearFilters })
    clear.onclick = () => {
      clearPicks()
      state.filters = { who: null, where: null, keep: null }
      renderList()
    }
    chips.push(clear)
  }
  $('chips').replaceChildren(...chips)
  $('chips').hidden = chips.length === 0
}

function setFilter(key, value) {
  clearPicks()
  state.filters = { ...state.filters, [key]: value }
  renderList()
  $('file-list').scrollTop = 0
}

function setSort(sort) {
  state.sort = sort
  remember('sort', sort)
  renderList()
}

function sortMenu() {
  const t = state.t
  toggleMenu($('sort'), SORTS.map((sort) => ({
    text: t[`sort_${sort}`],
    checked: state.sort === sort,
    run: () => setSort(sort),
  })))
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
  clearPicks()
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
    for (const folder of inside(folderId).filter(isFolder).sort(folderOrder)) {
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

// A file's mark: the icon the App that opens it declared for its kind (entry.claimedBy.icon, worked out by the host) —
// never the App's own icon (owner 10-17: a markdown file drawn as a folder); else its suffix on a square coloured by its
// family (list.js), so a pdf, a clip and an archive are told apart at a glance. Hovered, it still says which App opens it.
function fileMark(entry) {
  const icon = entry.claimedBy?.icon
  if (icon) {
    const mark = Object.assign(document.createElement('img'), { className: 'file-mark', src: icon, alt: entry.claimedBy.name ?? '' })
    mark.title = entry.claimedBy.name
    return mark
  }
  const { label, family } = markOf(entry)
  const mark = document.createElement('span')
  mark.className = 'file-mark file-badge'
  mark.dataset.family = family
  mark.textContent = label
  mark.setAttribute('aria-hidden', 'true')
  if (entry.claimedBy) mark.title = entry.claimedBy.name
  // An image with a cloud copy: its picture, once it is on screen (until then, and if it cannot be read, its suffix).
  if (wantsThumb(entry)) thumbInto(mark, entry)
  return mark
}

// ─── thumbnails ─────────────────────────────────────────────────────────────
// An image is read as any image file is (files.open read-only, its blob), drawn small once, and kept for this page by
// its id and version; only the ones scrolled into view are read, a few at a time. A file kept on a machine is never
// read for its picture (that would upload it): it keeps its suffix.

const thumbs = new Map() // `${id}:${version}` → Promise<object URL | null>
const thumbWaiting = []
let thumbsReading = 0
const thumbSeen = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((seen) => {
    for (const { isIntersecting, target } of seen) {
      if (!isIntersecting) continue
      thumbSeen.unobserve(target)
      target.thumbWanted?.()
    }
  }, { rootMargin: '200px' })
  : null

function thumbInto(el, entry) {
  if (!thumbSeen) return
  const key = `${entry.id}:${entry.version ?? ''}`
  const draw = (url) => {
    if (!url) return
    el.style.backgroundImage = `url("${url}")`
    el.classList.add('has-thumb')
    el.textContent = ''
  }
  el.thumbWanted = () => {
    if (!thumbs.has(key)) thumbs.set(key, new Promise((done) => {
      thumbWaiting.push(() => thumbOf(entry).then(done, () => done(null)))
      nextThumb()
    }))
    void thumbs.get(key).then(draw)
  }
  thumbSeen.observe(el)
}

function nextThumb() {
  while (thumbsReading < 3 && thumbWaiting.length) {
    thumbsReading++
    thumbWaiting.shift()().finally(() => {
      thumbsReading--
      nextThumb()
    })
  }
}

async function thumbOf(entry) {
  const file = await gugu.files.open(entry, { readOnly: true })
  try {
    const bitmap = await createImageBitmap(await file.blob())
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height))
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) })
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const small = await new Promise((done) => canvas.toBlob(done, 'image/webp', 0.85))
    return small ? URL.createObjectURL(small) : null
  } finally {
    file.close()
  }
}

// What the machine a project chat's file stays on says of it: which machine, that it is uploaded only when someone opens
// it, and whose file storage setting it follows.
function storedOnText(storedOn) {
  const t = state.t
  const machine = storedOn.machine ?? fmt(t.machineOf, { owner: storedOn.owner })
  return storedOn.mine ? fmt(t.storedOnMine, { machine }) : fmt(t.storedOnOther, { owner: storedOn.owner })
}

// A project chat's file that stays on its host machine (entry.storedOn): the machine, named, at the row's end; the rest
// on hover.
function storedOnMark(storedOn) {
  const mark = document.createElement('span')
  mark.className = 'file-host'
  mark.title = `${machineOf(storedOn)} · ${storedOnText(storedOn)}`
  const icon = document.createElement('gugu-icon')
  icon.setAttribute('name', 'server')
  icon.setAttribute('aria-hidden', 'true')
  mark.append(icon)
  // Whether it is on (storedOn.online; known for the reader's own machines): a dot, and the word on hover.
  if (storedOn.online !== undefined) {
    mark.dataset.online = String(storedOn.online)
    mark.title = `${machineOf(storedOn)} · ${storedOn.online ? state.t.machineOnline : state.t.machineOffline} — ${mark.title}`
  }
  mark.setAttribute('aria-label', mark.title)
  return mark
}

// A project file whose machine is off (as the list last read it), with no cloud copy to open meanwhile: it opens once the
// machine is back.
const offline = (entry) => entry.storedOn?.online === false && !entry.keep

// A press on a file: the host picks the App that opens it — or, its machine off, the list says why it cannot now.
function openFile(entry) {
  if (offline(entry)) return void showBanner(fmt(state.t.hostOffline, { machine: machineOf(entry.storedOn) }), 'info')
  return openInHost(entry)
}

// A cloud copy kept for a while (entry.keep.expiresAt): how long it has left, faint (owner 10-28) — the day it goes on hover.
function keepMark(entry, now) {
  const left = timeLeft(entry.keep?.expiresAt, now)
  if (!left || Date.parse(entry.keep.expiresAt) - now.getTime() > 3 * 86400000) return null
  const t = state.t
  const mark = document.createElement('span')
  mark.className = 'file-keep'
  if (left.minutes !== undefined || left.hours !== undefined) mark.dataset.soon = ''
  mark.textContent = left.days !== undefined ? fmt(t.leftDays, { n: left.days }) : left.hours !== undefined ? fmt(t.leftHours, { n: left.hours }) : fmt(t.leftMinutes, { n: left.minutes })
  mark.title = fmt(t.clearsAt, { time: new Intl.DateTimeFormat(state.ctx?.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.keep.expiresAt)) })
  return mark
}

// When, as a list says it: the time today (and yesterday, under its own heading), the day this year, the date before.
function whenOf(iso, now) {
  const at = new Date(iso ?? '')
  if (!Number.isFinite(at.getTime())) return ''
  const locale = state.ctx?.locale || 'en'
  const section = sectionOf(iso, now)
  if (section.kind === 'today') return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
  if (section.kind === 'yesterday') {
    const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
    return state.sort === 'recent' ? clock : `${state.t.yesterday} ${clock}`
  }
  return new Intl.DateTimeFormat(locale, at.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { dateStyle: 'medium' }).format(at)
}

// Narrow rows show the modified time; the same rows add a size column where wide. Activity stays in hover and Details.
function metaOf(entry, now) {
  const t = state.t
  const cells = []
  if (isFolder(entry)) {
    cells.push(['size', fmt(t.items, { n: inside(entry.id).filter(visibleEntry).length })])
  } else {
    const when = whenOf(changedAt(entry), now)
    if (when) cells.push(['when', when])
    const size = sizeOf(entry.size)
    if (size) cells.push(['size', size])
  }
  return cells
}

const fileTip = (entry) => [
  pathOf(entry), ...activityOf(entry), sizeOf(entry.size), entry.storedOn ? machineOf(entry.storedOn) : '',
  entry.keep ? entry.keep.expiresAt ? state.t.keepTemporary : state.t.keepPermanent : '',
].filter(Boolean).join(' · ')

function listItem(entry, now = new Date(Date.now())) {
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
    open.append(folderMark())
  } else {
    open.append(fileMark(entry))
  }
  title.append(name)
  // The whole name — suffix included — stays one hover (and the details) away; where it is, when the list is a search.
  open.title = folder ? pathOf(entry) : fileTip(entry)
  const meta = document.createElement('span')
  meta.className = 'file-meta'
  for (const [cell, text] of metaOf(entry, now)) {
    const span = Object.assign(document.createElement('span'), { className: 'file-cell', textContent: text })
    span.dataset.cell = cell
    meta.append(span)
  }
  if (!folder) meta.title = activityOf(entry).join(' · ')
  open.append(title)
  const where = state.filter.trim() && entry.parentId ? pathOf(entry).split('/').slice(0, -1).join('/') : ''
  if (where) meta.prepend(Object.assign(document.createElement('span'), { className: 'file-path', textContent: where }))
  open.append(meta)
  open.onclick = (event) => (folder ? enterFolder(entry.id) : pressFile(entry, event))
  if (!folder) pickable(li, entry)
  if (offline(entry)) li.dataset.offline = ''
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
  // At the row's end: how long its cloud copy has left, and the machine it stays on.
  li.append(open)
  const marks = [keepMark(entry, now), entry.storedOn ? storedOnMark(entry.storedOn) : null].filter(Boolean)
  if (marks.length) {
    const box = Object.assign(document.createElement('span'), { className: 'file-marks' })
    box.append(...marks)
    title.append(box)
  }
  fileMenu(li, open, entry)
  return li
}

// A cell of the grid (images and videos): its picture — or its suffix, large — with its name under it; how long its cloud
// copy has left in a corner; the same context menu as its row.
function gridItem(entry, now) {
  const li = document.createElement('li')
  li.className = 'file cell'
  li.dataset.id = entry.id
  li.setAttribute('role', 'option')
  li.setAttribute('aria-selected', 'false')
  if (offline(entry)) li.dataset.offline = ''
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'file-open'
  open.title = fileTip(entry)
  const mark = fileMark(entry)
  mark.classList.add('cell-picture')
  if (/^video\//i.test(entry.contentType || '')) {
    mark.textContent = ''
    const play = document.createElement('gugu-icon')
    play.setAttribute('name', 'play')
    play.className = 'cell-play'
    mark.append(play)
  }
  open.append(mark, Object.assign(document.createElement('span'), { className: 'file-name', textContent: shownName(entry) }))
  open.onclick = (event) => pressFile(entry, event)
  li.append(open)
  pickable(li, entry)
  const keep = keepMark(entry, now)
  if (keep) li.append(Object.assign(keep, { className: `${keep.className} cell-keep` }))
  if (entry.storedOn) li.append(Object.assign(storedOnMark(entry.storedOn), { className: 'file-host cell-host' }))
  fileMenu(li, open, entry)
  return li
}

// File rows and grid cells use the page's existing menu, with the same actions and permission checks.
function rowMenu(li, entry) {
  const t = state.t
  const folder = isFolder(entry)
  const open = { text: t.open, run: () => folder ? enterFolder(entry.id) : openFile(entry) }
  const openWith = { text: t.openWith, run: () => openInHost(entry, true) }
  const change = canWrite() && !entry.systemRole
    ? [{ text: t.rename, run: () => startRename(li, entry) }, { text: t.move, run: () => showMoveDialog(entry) }] : []
  const remove = canWrite() && !entry.systemRole && entry.canDelete
    ? [{ text: t.remove, run: () => removeFile(entry), ask: folder && under(entry.id).length ? fmt(t.confirmRemoveFolder, { n: under(entry.id).length }) : t.confirmRemove }] : []
  const groups = [[open]]
  if (folder) groups.push(change)
  else {
    const use = [{ text: t.download, run: () => downloadEntry(entry) }, { text: t.copyLink, run: () => copyLink(entry) }]
    if (entry.sourceMessageIds?.length) use.push({ text: t.showInChat, run: () => showSource(entry.sourceMessageIds.at(-1)) })
    const detail = { text: t.details, run: () => showDetails(entry) }
    const select = { text: t.pick, run: () => { state.selecting = true; pick(entry.id, 'toggle') } }
    const keep = []
    if (entry.keep || entry.storedOn) {
      const temporary = !!entry.keep?.expiresAt
      const why = !entry.keep ? storedOnText(entry.storedOn) : !entry.keep.mine ? t.keepNotMine : !canWrite() ? t.denied : t.keepTip
      const usable = !!entry.keep?.mine && canWrite()
      keep.push({ text: t.keep, title: why, children: [
        { text: t.keepTemporary, checked: !!entry.keep && temporary, disabled: !usable, title: why, run: () => keepAs(entry, 'temporary') },
        { text: t.keepPermanent, checked: !!entry.keep && !temporary, disabled: !usable, title: why, run: () => keepAs(entry, 'permanent') },
      ] })
    }
    if (touchPane?.matches) {
      groups.push(use, [...change.slice(0, 1), select], [{ text: t.more, children: [openWith, ...change.slice(1), ...keep, detail] }])
    } else {
      groups[0].push(openWith)
      groups.push(use, change, keep, [select, detail])
    }
  }
  groups.push(remove)
  return groups.filter((group) => group.length).flatMap((group, i) => i ? [{ separator: true }, ...group] : group)
}

function fileMenu(li, open, entry) {
  const show = (point) => {
    const items = !isFolder(entry) && state.picked.size
      ? [...pickedActions(), { separator: true }, { text: state.t.pickCancel, run: clearPicks }] : rowMenu(li, entry)
    toggleMenu(open, items, { point, entry: state.picked.size && !isFolder(entry) ? null : entry, selection: state.picked.size && !isFolder(entry) })
  }
  let timer = null
  let held = false
  let from = null
  const cancel = () => { clearTimeout(timer); timer = null }
  li.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const holding = timer !== null
    cancel()
    if (!held) {
      held = holding
      show({ x: event.clientX, y: event.clientY })
    }
  })
  li.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea')) return
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault()
      show()
    } else if (state.picked.size <= 1 && canWrite() && !entry.systemRole) {
      if (event.key === 'F2') { event.preventDefault(); startRename(li, entry) }
      if (event.key === 'Delete' && entry.canDelete) {
        event.preventDefault()
        const remove = rowMenu(li, entry).find((item) => item.ask)
        toggleMenu(open, [{ ...remove, text: remove.ask }], { entry })
      }
    }
  })
  open.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return
    cancel()
    held = false
    from = { x: event.clientX, y: event.clientY }
    timer = setTimeout(() => { timer = null; if (li.isConnected) { held = true; show(from) } }, 500)
  })
  open.addEventListener('pointermove', (event) => {
    if (from && (Math.abs(event.clientX - from.x) > 8 || Math.abs(event.clientY - from.y) > 8)) cancel()
  })
  open.addEventListener('pointerup', cancel)
  open.addEventListener('pointercancel', () => { cancel(); held = false })
  open.addEventListener('click', (event) => {
    if (!held) return
    held = false
    event.stopImmediatePropagation()
    event.preventDefault()
  }, true)
}

async function keepAs(entry, how) {
  hideBanner()
  try {
    await gugu.files.keep(entry, how)
  } catch (error) {
    showBanner(error.code === 'denied' ? state.t.keepNotMine : error.code === 'invalid' ? state.t.keepNone : fmt(state.t.failed, { e: error.message }), 'error')
  }
  await refreshList()
}

async function downloadEntry(entry) {
  try {
    await gugu.files.download(entry) // false: the person cancelled the save dialog, nothing to say
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

function showSource(messageId) {
  gugu.showMessage(messageId).catch((error) => showBanner(error.code === 'not-found' ? state.t.sourceGone : fmt(state.t.failed, { e: error.message }), 'error'))
}

async function copyLink(entry) {
  try {
    await gugu.clipboard.writeText(await gugu.linkTo({ kind: 'file', file: entry }))
    showBanner(state.t.linkCopied, 'info')
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
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
  if (state.shown) await downloadEntry(state.shown)
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
  $('doc-empty').hidden = true
  document.body.classList.remove('empty-doc')
  hideBlockHandle()
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
    // A task is ticked where it is read (its line's [ ] / [x], below); not in a file this person may only read.
    for (const box of $('preview').querySelectorAll('li > input[type=checkbox], li > p:first-child > input[type=checkbox]')) box.disabled = !!file.readOnly
    const empty = !file.text.trim()
    document.body.classList.toggle('empty-doc', empty)
    $('doc-empty').hidden = !empty
    $('empty-write').hidden = $('empty-draft').hidden = !!file.readOnly
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
  document.body.classList.toggle('picks-in-preview', picksInPreview)
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

// ─── the source's marks and the reading page's blocks (owner 10-30, folder-docs) ───────────────────────────────────

// Wraps each range of the source's selection in a mark — **bold**, *italic*, `code`, [link]() — or takes the mark away
// when it is already around it: one change to the same text everyone edits. A link leaves the caret in its ().
const MARKS = { bold: ['**', '**'], italic: ['*', '*'], code: ['`', '`'], link: ['[', ']()'] }

function format(kind) {
  const view = state.current?.view
  if (!view || picksInPreview || view.state.readOnly || !MARKS[kind]) return
  const [open, close] = MARKS[kind]
  const { EditorSelection } = state.cm.state
  const doc = view.state
  view.dispatch(doc.changeByRange((range) => {
    const wrapped = kind !== 'link' && doc.sliceDoc(range.from - open.length, range.from) === open && doc.sliceDoc(range.to, range.to + close.length) === close
    if (wrapped) {
      return {
        changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }],
        range: EditorSelection.range(range.from - open.length, range.to - open.length),
      }
    }
    const end = range.to + open.length
    return {
      changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
      range: kind === 'link' ? EditorSelection.cursor(end + 2) : EditorSelection.range(range.from + open.length, end),
    }
  }))
  view.focus()
}

// Reading with a pointer: the top-level block under it gets a ⋯ in its left margin. Its menu does with the whole block
// what a selection's bar does (Cite, ＋ Keep), copies a link to its lines (the pill's own `at`), or shows them in the source.
let handleBlock = null

function hideBlockHandle() {
  if ($('menu').hidden || state.menuAnchor !== $('block-handle')) {
    handleBlock = null
    $('block-handle').hidden = true
  }
}

function showBlockHandle(event) {
  if (touchPane?.matches || !state.current || state.current.file.type !== 'text') return
  const root = $('preview').firstElementChild
  let block = null
  for (let node = event.target; node && node !== root && node !== $('preview'); node = node.parentElement) if (node.parentElement === root) block = node
  if (!block?.dataset.line) return hideBlockHandle()
  if (block === handleBlock && !$('block-handle').hidden) return
  handleBlock = block
  const box = block.getBoundingClientRect()
  const pane = $('preview').getBoundingClientRect()
  const handle = $('block-handle')
  handle.hidden = false
  handle.style.top = `${box.top + 2}px`
  handle.style.left = `${Math.max(pane.left + 2, box.left - handle.offsetWidth - 6)}px`
}

function blockMenu() {
  const current = state.current
  const block = handleBlock
  const span = spanOf(block?.dataset.line)
  if (!current || !span) return
  const t = state.t
  const pick = { text: block.innerText || block.textContent || '', lines: span }
  toggleMenu($('block-handle'), [
    [t.citeBlock, () => void cite(current, [pick], state.held)],
    [t.holdBlock, () => {
      state.held.push(refOf(current, pick))
      renderHeld()
    }],
    [t.copyBlockLink, () => void copyBlockLink(current, span)],
    [t.findSource, () => findInSource(span)],
  ])
}

async function copyBlockLink(current, [first, last]) {
  try {
    await gugu.clipboard.writeText(await gugu.linkTo({ kind: 'file', file: current.entry, at: placeOf(current.file.text, first, last) }))
    showBanner(state.t.linkCopied, 'info')
    setTimeout(() => { if ($('banner').textContent === state.t.linkCopied) hideBanner() }, 1500)
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

// The block's lines marked in the source, as a pill's are: beside the reading when there is room, else the source alone.
function findInSource(span) {
  if (state.mode === 'preview') setMode(narrowPane?.matches ? 'edit' : 'split')
  state.found = { lines: span, said: false }
  applyMarks()
  const view = state.current?.view
  if (view) view.dispatch({ effects: state.cm.EditorView.scrollIntoView(view.state.doc.line(Math.min(span[0], view.state.doc.lines)).from, { y: 'center' }) })
}

// A task ticked in the reading page ticks its line in the source: that line's `[ ]` / `[x]`, nothing else.
function tickTask(event) {
  const box = event.target
  if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !$('preview').contains(box)) return
  const view = state.current?.view
  const n = spanOf(box.closest('li[data-line]')?.dataset.line)?.[0]
  const line = view && n && n <= view.state.doc.lines ? view.state.doc.line(n) : null
  const mark = line && /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)[ xX]\]/.exec(line.text)
  if (!mark || view.state.readOnly) {
    box.checked = !box.checked
    return
  }
  const at = line.from + mark[1].length
  view.dispatch({ changes: { from: at, to: at + 1, insert: box.checked ? 'x' : ' ' } })
}

// The source reads like writing (owner 10-30, folder-docs): the body font, headings by their level, the marks (#, **, >,
// a link's address, front matter) faded, no underlines; in the theme's own colours, so dark reads as well as light (the
// default style's active line and links were light-theme colours on a dark page). Line numbers: style.css (编辑 hides them).
function editorTheme(cm, prose = true) {
  const look = cm.EditorView.theme({
    '&': { height: '100%', color: 'var(--em-foreground)', backgroundColor: 'transparent' },
    '.cm-scroller': prose ? { fontFamily: 'var(--em-font-sans)', fontSize: '15px', lineHeight: '1.7' } : { fontFamily: 'var(--em-font-mono)', lineHeight: '1.6' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--em-foreground-passive)', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { color: 'var(--em-foreground-muted)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--em-hover)' },
    '&.cm-focused': { outline: 'none' },
  })
  if (!prose) return look
  const { tags: t } = cm.lezerHighlight
  const writing = cm.language.HighlightStyle.define([
    { tag: t.heading1, fontSize: '1.5em', fontWeight: '600' },
    { tag: t.heading2, fontSize: '1.25em', fontWeight: '600' },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
    { tag: [t.processingInstruction, t.contentSeparator, t.url], color: 'var(--em-foreground-passive)' },
    { tag: t.meta, color: 'var(--em-foreground-passive)', fontFamily: 'var(--em-font-mono)', fontSize: '0.8125em' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: 'var(--em-foreground-info)' },
    { tag: t.monospace, fontFamily: 'var(--em-font-mono)', fontSize: '0.875em' },
  ])
  return [look, cm.language.syntaxHighlighting(writing)]
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
        editorTheme(cm, false),
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
      extensions: [cm.basicSetup, current.file.type === 'text' ? markdownSupport(cm) : cm.json(), cm.EditorView.lineWrapping, editorTheme(cm, current.file.type === 'text'), selectionWatch(cm), cm.EditorState.readOnly.of(true), cm.EditorView.editable.of(false)],
    })
  }
  document.body.classList.add('gone')
  refreshList()
}

function watchPresence(current) {
  const render = (others) => {
    if (state.current !== current) return
    // The host's avatar of each one here, ringed in their presence colour (the colour their cursor is drawn in).
    const chips = others.map((peer) => {
      const chip = document.createElement('gugu-avatar')
      chip.className = 'peer'
      chip.setAttribute('user', peer.userId)
      chip.setAttribute('size', 'xs')
      chip.setAttribute('label', peer.name || peer.userId.slice(0, 6))
      chip.style.setProperty('--peer', peer.color)
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
const touchPane = window.matchMedia?.('(hover: none) and (pointer: coarse)') ?? null

function setMode(mode) {
  state.mode = mode
  applyMode()
}

function applyMode() {
  const mode = narrowPane?.matches && state.mode === 'split' ? 'preview' : state.mode
  document.body.dataset.mode = mode
  for (const m of ['edit', 'split', 'preview']) $(`mode-${m}`).setAttribute('aria-selected', String(m === mode))
}

// The page's one menu (#menu): file context menus and the open file's actions. At the pointer or control, above when there
// is no room below; a press elsewhere, Escape, a scroll or a resize closes it, and so does choosing an item. An item that
// asks first (`ask`: Delete, in red) only says its question on the first press; the items are made anew on every open,
// so closing the menu takes the question back. The keyboard goes with it: in on the first item, back to its control on close.
function toggleMenu(anchor, items, context = {}) {
  const again = state.menuAnchor === anchor
  closeMenu()
  if (again) return
  const menu = $('menu')
  // An item: `[text, run, ask]`, or `{ text, run, ask, checked, disabled, title }`; `{ label }` names the items after it,
  // `{ separator: true }` sets groups apart. A `checked` one is one of a choice (its state shown by a tick).
  const nodes = (entries) => entries.map((given) => {
    const { text, run, ask, checked, disabled, title, label, separator, children } = Array.isArray(given) ? { text: given[0], run: given[1], ask: given[2] } : given
    if (separator) return Object.assign(document.createElement('div'), { className: 'menu-separator', role: 'separator' })
    if (label) {
      const head = Object.assign(document.createElement('div'), { className: 'menu-label', textContent: label })
      head.setAttribute('role', 'presentation')
      if (title) head.title = title
      return head
    }
    const item = document.createElement('button')
    item.type = 'button'
    if (ask) item.className = 'destructive'
    if (checked !== undefined) {
      item.setAttribute('role', 'menuitemradio')
      item.setAttribute('aria-checked', String(checked))
      item.classList.add('menu-choice')
    } else {
      item.setAttribute('role', 'menuitem')
    }
    item.textContent = children ? `${text} ›` : text
    if (children) item.setAttribute('aria-haspopup', 'menu')
    if (title) item.title = title
    if (disabled) item.disabled = true
    let submenu = null
    item.onclick = () => {
      if (submenu) return void submenu.querySelector('button:not(:disabled)')?.focus()
      if (ask && item.textContent !== ask) return void (item.textContent = ask)
      closeMenu()
      if (children) toggleMenu(anchor, [{ text: `‹ ${text}`, run: () => toggleMenu(anchor, items, context) }, { separator: true }, ...children], context)
      else run()
    }
    if (children && !touchPane?.matches) {
      const group = Object.assign(document.createElement('div'), { className: 'menu-group', role: 'presentation' })
      submenu = Object.assign(document.createElement('div'), { className: 'menu-submenu card list', role: 'menu' })
      submenu.append(...nodes(children))
      group.append(item, submenu)
      item.onkeydown = (event) => {
        if (event.key === 'ArrowRight') { event.preventDefault(); submenu.querySelector('button:not(:disabled)')?.focus() }
      }
      return group
    }
    return item
  })
  menu.replaceChildren(...nodes(items))
  const fileContext = !!(context.entry || context.selection)
  menu.classList.toggle('file-context', fileContext)
  if (fileContext && touchPane?.matches) {
    const heading = Object.assign(document.createElement('div'), { className: 'menu-file' })
    const words = Object.assign(document.createElement('div'), { className: 'menu-file-words' })
    words.append(Object.assign(document.createElement('strong'), { textContent: context.selection ? fmt(state.t.picked, { n: state.picked.size }) : shownName(context.entry) }))
    if (context.entry) {
      words.append(Object.assign(document.createElement('small'), { textContent: fileTip(context.entry) }))
      heading.append(isFolder(context.entry) ? folderMark() : fileMark(context.entry))
    }
    heading.append(words)
    menu.prepend(heading)
  }
  state.menuAnchor = anchor
  anchor.setAttribute('aria-expanded', 'true')
  menu.hidden = false
  menu.style.top = menu.style.left = ''
  if (!fileContext || !touchPane?.matches) {
    const box = context.point ? { left: context.point.x, right: context.point.x, top: context.point.y, bottom: context.point.y } : anchor.getBoundingClientRect()
    const below = box.bottom + 4 + menu.offsetHeight <= innerHeight - 8
    menu.style.top = `${below ? box.bottom + 4 : Math.max(8, box.top - 4 - menu.offsetHeight)}px`
    let left = Math.max(8, Math.min(context.point ? box.left : box.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))
    const subWidth = Math.min(180, innerWidth - menu.offsetWidth - 24)
    const opensLeft = !!menu.querySelector('.menu-submenu') && left + menu.offsetWidth + subWidth > innerWidth - 8
    if (opensLeft) left = Math.max(left, subWidth + 8)
    menu.classList.toggle('submenu-left', opensLeft)
    menu.style.setProperty('--submenu-width', `${subWidth}px`)
    menu.style.left = `${left}px`
  }
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
}

// ─── 多选 ───────────────────────────────────────────────────────────────────
// Ctrl/⌘ picks, Shift picks a range, and a frame picks rows across the list's empty space. The phone's explicit selection
// mode shows a separate checkbox column; a long press opens the same row menu. While anything is
// picked a press picks too. What is picked can be downloaded at once, made temporary or kept, and found in the chat one
// message after another. Folders are not picked; a change of folder, kind or filter lets go of all.

function pickable(li, entry) {
  const box = document.createElement('button')
  box.type = 'button'
  box.className = 'file-pick'
  box.setAttribute('role', 'checkbox')
  box.setAttribute('aria-label', state.t.pick)
  box.setAttribute('aria-checked', String(state.picked.has(entry.id)))
  box.onclick = (event) => {
    event.stopPropagation()
    pick(entry.id, event.shiftKey ? 'range' : 'toggle')
  }
  li.prepend(box)
  if (state.picked.has(entry.id)) li.classList.add('picked')
}

// A press on a file: with Shift, the run to it; with Ctrl/⌘ — or while anything is picked — it is picked or let go; else it opens.
function pressFile(entry, event) {
  if (event?.shiftKey) return pick(entry.id, 'range')
  if (event?.ctrlKey || event?.metaKey || state.picked.size || state.selecting) return pick(entry.id, 'toggle')
  state.pickFrom = entry.id
  return openFile(entry)
}

function pick(id, how) {
  if (how === 'range' && state.pickFrom) for (const one of rangeOf(state.order, state.pickFrom, id)) state.picked.add(one)
  else if (state.picked.has(id)) state.picked.delete(id)
  else state.picked.add(id)
  if (how !== 'range') state.pickFrom = id
  state.locating = null
  renderPicks()
}

function clearPicks() {
  if (!state.picked.size && !state.locating && !state.selecting) return
  state.selecting = false
  state.picked.clear()
  state.locating = null
  renderPicks()
}

const pickedEntries = () => state.order.filter((id) => state.picked.has(id)).map((id) => state.entries.find((e) => e.id === id)).filter(Boolean)

// The same four batch actions in the toolbar and the selection's context menu.
const pickedActions = () => [
  { text: state.t.pickDownload, run: downloadPicked },
  ...(canWrite() ? [{ text: state.t.pickTemporary, run: () => keepPicked('temporary') }, { text: state.t.pickPermanent, run: () => keepPicked('permanent') }] : []),
  { text: state.t.pickLocate, run: startLocate },
]

function pickAll() {
  state.picked = new Set(state.order.every((id) => state.picked.has(id)) ? [] : state.order)
  state.locating = null
  renderPicks()
}

// The rows say whether they are picked; the bar says how many, and what to do with them.
function renderPicks() {
  const t = state.t
  for (const li of $('file-list').querySelectorAll('li.file')) {
    const on = state.picked.has(li.dataset.id)
    li.classList.toggle('picked', on)
    li.setAttribute('aria-selected', String(on || state.current?.entry.id === li.dataset.id))
    li.querySelector('.file-pick')?.setAttribute('aria-checked', String(on))
  }
  const count = state.picked.size
  if (!count && !touchPane?.matches) state.selecting = false
  $('file-list').classList.toggle('selecting', state.selecting || count > 0)
  document.querySelector('aside.files').classList.toggle('has-picks', count > 0)
  const select = $('select-files')
  select.textContent = state.selecting || count ? t.pickDone : t.pick
  select.setAttribute('aria-pressed', String(state.selecting || count > 0))
  const all = $('file-list').querySelector('.pick-all')
  all?.setAttribute('aria-checked', count && count === state.order.length ? 'true' : count ? 'mixed' : 'false')
  const bar = $('pick-bar')
  bar.hidden = count === 0
  if (!count) return void bar.replaceChildren()
  const act = (text, run, more = {}) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick: run, ...more })
  const locating = state.locating
  const locate = locating
    ? [act('‹', () => stepLocate(-1), { title: t.pickPrev, disabled: locating.at === 0 }),
      Object.assign(document.createElement('span'), { className: 'pick-at', textContent: fmt(t.pickLocateAt, { i: locating.at + 1, n: locating.ids.length }) }),
      act('›', () => stepLocate(1), { title: t.pickNext, disabled: locating.at === locating.ids.length - 1 })]
    : [act(t.pickLocate, startLocate)]
  bar.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'pick-count', textContent: fmt(t.picked, { n: count }) }),
    ...pickedActions().slice(0, -1).map(({ text, run }) => act(text, run)),
    ...locate,
    act('✕', () => clearPicks(), { className: 'pick-close', title: t.pickCancel, ariaLabel: t.pickCancel }),
  )
}

// Download what is picked at once (API 20): one folder asked for them all on the desktop, the share sheet on the phone.
async function downloadPicked() {
  const entries = pickedEntries()
  if (!entries.length) return
  hideBanner()
  try {
    const saved = await gugu.files.download(entries)
    if (typeof saved === 'number' && saved > 0) showBanner(fmt(state.t.savedFiles, { n: saved }), 'info')
  } catch (error) {
    showBanner(fmt(state.t.failed, { e: error.message }), 'error')
  }
}

// Make what is picked temporary, or keep it: only the person's own cloud copies are asked for (one refusal would refuse
// the whole call); the rest are said apart.
async function keepPicked(how) {
  const t = state.t
  const { mine, notMine, noCopy } = keepable(pickedEntries())
  hideBanner()
  const said = []
  try {
    if (mine.length) said.push(fmt(t.keptFiles, { n: (await gugu.files.keep(mine, how))?.changed ?? mine.length }))
  } catch (error) {
    return void showBanner(error.code === 'denied' ? t.keepNotMine : fmt(t.failed, { e: error.message }), 'error')
  }
  if (notMine.length) said.push(fmt(t.skippedNotMine, { n: notMine.length }))
  if (noCopy.length) said.push(fmt(t.skippedNoCopy, { n: noCopy.length }))
  await refreshList()
  showBanner(said.join(' '), 'info')
}

// 「在聊天中定位」 for a selection: their messages, oldest first, one after another (1/3 ‹ ›).
function startLocate() {
  const ids = pickedEntries()
    .filter((e) => e.sourceMessageIds?.length)
    .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
    .map((e) => e.sourceMessageIds[e.sourceMessageIds.length - 1])
  if (!ids.length) return void showBanner(state.t.noSources, 'info')
  state.locating = { ids: [...new Set(ids)], at: 0 }
  renderPicks()
  showSource(state.locating.ids[0])
}

function stepLocate(by) {
  const locating = state.locating
  if (!locating) return
  locating.at = Math.max(0, Math.min(locating.ids.length - 1, locating.at + by))
  renderPicks()
  showSource(locating.ids[locating.at])
}

// A frame dragged across the list's empty space picks every file it crosses (added to what is picked).
function lasso() {
  const list = $('file-list')
  let from = null
  let before = null
  const frame = $('lasso')
  list.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType !== 'mouse' || event.target.closest('li.file, button, input')) return
    from = { x: event.clientX, y: event.clientY }
    before = new Set(state.picked)
    list.setPointerCapture?.(event.pointerId)
  })
  list.addEventListener('pointermove', (event) => {
    if (!from) return
    const box = { left: Math.min(from.x, event.clientX), top: Math.min(from.y, event.clientY), right: Math.max(from.x, event.clientX), bottom: Math.max(from.y, event.clientY) }
    if (box.right - box.left < 4 && box.bottom - box.top < 4) return
    event.preventDefault()
    Object.assign(frame.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` })
    frame.hidden = false
    state.picked = new Set(before)
    for (const li of list.querySelectorAll('li.file')) {
      if (!state.order.includes(li.dataset.id)) continue
      const r = li.getBoundingClientRect()
      if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) state.picked.add(li.dataset.id)
    }
    renderPicks()
  })
  const end = () => {
    from = null
    frame.hidden = true
  }
  list.addEventListener('pointerup', end)
  list.addEventListener('pointercancel', end)
}

// ─── details ────────────────────────────────────────────────────────────────
// A file's details (⋯ › 详情): beside the list where the pane is wide, over it where it is narrow (style.css) — what the row
// says in full, where it is kept and for how long, and its versions (files.versions), with open, download and its message.
function showDetails(entry) {
  const t = state.t
  const same = state.details?.id === entry.id
  state.details = entry
  const panel = $('details')
  const head = document.createElement('div')
  head.className = 'details-head'
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'details-close', innerHTML: '<gugu-icon name="x"></gugu-icon>' })
  close.setAttribute('aria-label', t.close)
  close.onclick = () => closeDetails()
  head.append(Object.assign(document.createElement('h2'), { className: 'details-title', textContent: shownName(entry), title: entry.name }), close)
  const picture = fileMark(entry)
  picture.classList.add('details-picture')
  if (!wantsThumb(entry)) picture.classList.add('details-badge')
  const actions = document.createElement('div')
  actions.className = 'details-actions'
  const act = (text, run) => Object.assign(document.createElement('button'), { type: 'button', textContent: text, onclick: run })
  actions.append(act(t.open, () => openFile(entry)), act(t.download, () => downloadEntry(entry)))
  if (entry.sourceMessageIds?.length) actions.append(act(t.showInChat, () => showSource(entry.sourceMessageIds[entry.sourceMessageIds.length - 1])))
  const facts = document.createElement('dl')
  facts.className = 'details-facts'
  const fact = (term, text, title) => {
    if (!text) return
    facts.append(Object.assign(document.createElement('dt'), { textContent: term }), Object.assign(document.createElement('dd'), { textContent: text, ...(title ? { title } : {}) }))
  }
  const dated = (iso) => (iso ? new Intl.DateTimeFormat(state.ctx?.locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '')
  fact(t.d_size, [sizeOf(entry.size), entry.suffix ? entry.suffix.slice(1).toUpperCase() : ''].filter(Boolean).join(' · '))
  fact(t.d_by, [entry.createdBy && entry.createdBy.kind !== 'system' ? who(entry.createdBy) : '', dated(entry.createdAt)].filter(Boolean).join(' · '))
  if (entry.updatedAt && entry.createdAt && Date.parse(entry.updatedAt) - Date.parse(entry.createdAt) > 60_000) {
    fact(t.d_edited, [entry.updatedBy ? who(entry.updatedBy) : '', dated(entry.updatedAt), entry.version ? fmt(t.d_version, { n: entry.version }) : ''].filter(Boolean).join(' · '))
  }
  const folders = []
  for (let at = state.entries.find((e) => e.id === entry.parentId); at; at = state.entries.find((e) => e.id === at.parentId)) folders.unshift(shownName(at))
  fact(t.d_where, [t.title, ...folders].join(' / '))
  if (entry.storedOn) fact(t.d_stored, `${machineOf(entry.storedOn)}${entry.storedOn.online === undefined ? '' : ` · ${entry.storedOn.online ? t.machineOnline : t.machineOffline}`}`, storedOnText(entry.storedOn))
  const left = entry.keep?.expiresAt ? fmt(t.clearsAt, { time: dated(entry.keep.expiresAt) }) : null
  if (entry.keep !== undefined) fact(t.d_keep, !entry.keep ? t.noCopy : left ? `${t.keepTemporary} · ${left}` : t.keepPermanent, entry.keep && !entry.keep.mine ? t.keepNotMine : undefined)
  const versions = document.createElement('ol')
  versions.className = 'details-versions'
  const versionsHead = Object.assign(document.createElement('h3'), { className: 'details-sub', textContent: t.d_versions, hidden: true })
  panel.replaceChildren(head, picture, actions, facts, versionsHead, versions)
  // On a phone the details are a sheet: pulled down by its head, it goes.
  head.onpointerdown = (down) => {
    if (down.pointerType === 'mouse') return
    const from = down.clientY
    head.onpointerup = (up) => {
      head.onpointerup = null
      if (up.clientY - from > 60) closeDetails()
    }
  }
  panel.hidden = false
  document.body.classList.add('has-details')
  if (!same) close.focus({ preventScroll: true })
  // Its history, newest first, when it has one (a working copy's file and a live document do not).
  if (entry.version && entry.version > 1 && typeof gugu.files.versions === 'function') {
    gugu.files.versions(entry).then((kept) => {
      if (state.details?.id !== entry.id) return
      versionsHead.hidden = kept.length === 0
      versions.replaceChildren(...kept.map((v) => Object.assign(document.createElement('li'), {
        textContent: [fmt(t.d_version, { n: v.n }), v.by ? who(v.by) : '', dated(v.at), sizeOf(v.size)].filter(Boolean).join(' · '),
      })))
    }, () => {})
  }
}

function closeDetails() {
  state.details = null
  $('details').hidden = true
  $('details').replaceChildren()
  document.body.classList.remove('has-details')
}

function closeMenu() {
  if ($('menu').contains(document.activeElement)) state.menuAnchor?.focus({ preventScroll: true })
  state.menuAnchor?.setAttribute('aria-expanded', 'false')
  state.menuAnchor = null
  $('menu').hidden = true
}

// ─── start ──────────────────────────────────────────────────────────────────

function start() {
  const folder = document.querySelector('aside.files')
  const blank = (target) => target instanceof Element && !target.closest('li, button, input, nav')
  folder.addEventListener('contextmenu', (event) => {
    if (!blank(event.target)) return
    event.preventDefault()
    void folderContextMenu(event.clientX, event.clientY)
  })
  folder.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.closest('input, textarea, [contenteditable]')) {
      event.preventDefault()
      state.picked = new Set(state.order)
      state.locating = null
      renderPicks()
      return
    }
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) || !blank(event.target)) return
    event.preventDefault()
    const rect = event.target.getBoundingClientRect()
    void folderContextMenu(rect.left + 8, rect.top + 8)
  })
  lasso()
  $('filter').oninput = (event) => {
    clearPicks()
    state.filter = event.target.value
    renderList()
  }
  $('select-files').onclick = () => {
    if (state.selecting || state.picked.size) clearPicks()
    else { state.selecting = true; renderPicks() }
  }
  $('sort').onclick = () => sortMenu()
  for (const button of $('views').children) {
    button.onclick = () => {
      remember(`view.${state.kind}`, button.dataset.view)
      renderList()
    }
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
    if (!state.menuAnchor && state.details) closeDetails()
    else if (!state.menuAnchor && (state.picked.size || state.selecting)) clearPicks()
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
  for (const button of document.querySelectorAll('#sel-bar .fmt')) {
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.onclick = () => format(button.dataset.fmt)
  }
  $('preview').addEventListener('pointermove', showBlockHandle)
  $('preview').addEventListener('pointerleave', (event) => { if (event.relatedTarget !== $('block-handle') && !$('block-handle').contains(event.relatedTarget)) hideBlockHandle() })
  $('preview').addEventListener('scroll', () => hideBlockHandle())
  $('block-handle').onclick = () => blockMenu()
  $('preview').addEventListener('change', tickTask)
  $('empty-write').onclick = () => {
    setMode(state.mode === 'split' && !narrowPane?.matches ? 'split' : 'edit')
    state.current?.view?.focus()
  }
  $('empty-draft').onclick = () => {
    const current = state.current
    if (current) gugu.dispatch(state.t.emptyAsk, { draft: true, refs: [{ file: current.entry }] }).catch((error) => showBanner(fmt(state.t.failed, { e: error.message }), 'error'))
  }
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
