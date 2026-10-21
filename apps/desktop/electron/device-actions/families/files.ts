/**
 * 文件(fs.* 16 个)。四个根 = 四个分组(桌面 / 文稿 / 下载 / 其他位置 = 个人文件夹里的其余地方),动作的 group 写 files,
 * 具体路径在动作里按根判(paths.ts,按真实位置,符号链接按指向)。在那之前先按字面判一次:落在没连上的根里的路径 ❌ 碰盘 ——
 * 碰了 macOS 就会替那个文件夹弹「允许咕咕访问…」,而用户在咕咕里根本没连它。
 * 走目录树(递归列目录 / 搜内容 / Spotlight 结果)同样不进没连上的根,也不进 ~/Library(别的 App 的数据,碰了会连弹授权框),
 * 符号链接不跟进去。删除只有「移到废纸篓」;覆盖、替换之前先问人,被替换掉的那个也进废纸篓。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import {
  MAC_PRIVACY,
  bad,
  bool,
  clampInt,
  fail,
  num,
  ok,
  str,
  type ActionDef,
  type ActionFamily,
  type ActionGroupDef,
  type ActionRunContext,
  type Args,
  type FamilyContext,
  type Outcome,
} from '../catalog'
import { MacScriptPermissionError } from '../mac-scripts'
import { NativeCallError } from '../native/mac-helper-client'
import { expandHome, grantedRootTitles, resolveInsideRoots, resolveTargetInsideRoots, rootDir, type FileRoot } from '../paths'

type Resolved = { ok: true; path: string } | { ok: false; message: string }
type NamedRoot = Exclude<FileRoot, 'files.other'>
type Tag = { name: string; color: string }

const NAMED: readonly NamedRoot[] = ['files.desktop', 'files.documents', 'files.downloads']
const LABEL: Record<FileRoot, string> = { 'files.desktop': '桌面', 'files.documents': '文稿', 'files.downloads': '下载', 'files.other': '个人文件夹' }
/** Finder 的八种标签颜色(顺序 = Finder 写进文件的颜色序号)。 */
const TAG_COLORS = ['none', 'gray', 'green', 'purple', 'blue', 'yellow', 'red', 'orange'] as const
const CONFIRMED = { [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'true only after the person agreed to exactly what the previous needs_confirmation asked' } }
const PATH_DOC = 'Absolute path, or one starting with ~/'

const LIST_BUDGET_MS = 20_000
const LIST_HARD_CAP = 10_000
const READ_TEXT_DEFAULT = 128 * 1024
const READ_TEXT_MAX = 1024 * 1024
const READ_B64_DEFAULT = 256 * 1024
const READ_B64_MAX = 4 * 1024 * 1024
const PICTURE_MAX = 5 * 1024 * 1024
const WRITE_MAX = 20 * 1024 * 1024
const PATCH_MAX = 10 * 1024 * 1024
const DIFF_MAX = 16 * 1024

// ───────────────────────── 小工具 ─────────────────────────

const lower = (p: string) => p.toLowerCase()
/** macOS 默认不分大小写:按字面判位置时一律不分(多拒不多放)。 */
const within = (p: string, dir: string) => lower(p) === lower(dir) || lower(p).startsWith(lower(dir) + path.sep)
const notConnected = (raw: string, granted: ReadonlySet<string>) =>
  `${raw} is not inside a location connected on this computer (connected: ${grantedRootTitles(granted).join(', ') || 'none'})`

/** 本地时间、带偏移(2026-10-15T14:48:11+08:00):agent 一眼看出是当地几点。 */
export function isoLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

const typeOf = (s: fs.Stats) => (s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other')

const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function askFirst(message: string, question: string, details?: unknown): Outcome {
  return { ok: false, code: 'needs_confirmation', message, confirm: { question, ...(details !== undefined ? { details } : {}) } }
}

const errnoOf = (error: unknown) => (error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined)

/** Node 的文件错误 → 设备动作的结果;原生助手 / 脚本的错原样抛给 provider(它认得)。 */
function fsError(error: unknown): Outcome {
  if (error instanceof NativeCallError || error instanceof MacScriptPermissionError) throw error
  const e = error as NodeJS.ErrnoException
  const where = typeof e?.path === 'string' ? `: ${e.path}` : ''
  switch (e?.code) {
    case 'ENOENT': return bad(`not found${where}`)
    case 'ENOTDIR': return bad(`a part of the path is a file, not a folder${where}`)
    case 'EISDIR': return bad(`this is a folder, not a file${where}`)
    case 'ENOTEMPTY': return bad(`the folder is not empty${where}`)
    case 'EPERM':
      // 文件夹里的东西被 macOS 隐私保护拦了(或文件被锁定)。❌ 报 os_permission:provider 会把四个根全标成不可用。
      return fail('execution_failed', `macOS did not allow 咕咕 to do this${where}. Inside Desktop / Documents / Downloads the person can allow 咕咕 under System Settings → Privacy & Security → Files and Folders; other protected places (Mail, Messages, other apps' data) need Full Disk Access. A locked file must be unlocked in Finder first.`)
    case 'EACCES': return fail('execution_failed', `the file's own permissions do not allow this${where}`)
    case 'ENOSPC': return fail('execution_failed', 'the disk is full')
    case 'EROFS': return fail('execution_failed', `that volume is read-only${where}`)
    case 'EXDEV': return fail('execution_failed', `cannot do this across volumes${where}`)
  }
  return fail('execution_failed', e instanceof Error ? e.message : String(error))
}

/** 文件动作:group 一律 files,文件错误统一翻译。 */
function fileAction(def: Omit<ActionDef, 'group'>): ActionDef {
  return {
    ...def,
    group: 'files',
    async run(args, ctx) {
      try {
        return await def.run(args, ctx)
      } catch (error) {
        return fsError(error)
      }
    },
  }
}

// ───────────────────────── 位置 ─────────────────────────

/** 按字面判:落在没连上的那个根里 ⇒ 直接拒,❌ 碰盘。只拒、不放 —— 放行由 paths.ts 按真实位置判。 */
function lexicalRefusal(raw: string, granted: ReadonlySet<string>): string | null {
  const expanded = expandHome(raw)
  if (!path.isAbsolute(expanded)) return null
  const abs = path.resolve(expanded)
  const home = os.homedir()
  return NAMED.some((r) => !granted.has(r) && within(abs, rootDir(r, home))) ? notConnected(raw, granted) : null
}

/** 已经存在的路径(读、改、看):按真实位置判,得到真实路径。 */
async function existingPath(raw: string, granted: ReadonlySet<string>): Promise<Resolved> {
  const refused = lexicalRefusal(raw, granted)
  return refused ? { ok: false, message: refused } : resolveInsideRoots(raw, granted)
}

/** 可能还不存在的路径(写入、新建)。 */
async function targetPath(raw: string, granted: ReadonlySet<string>): Promise<Resolved> {
  const refused = lexicalRefusal(raw, granted)
  return refused ? { ok: false, message: refused } : resolveTargetInsideRoots(raw, granted)
}

interface Scope {
  home: string
  /** 这个真实路径在不在连上了的位置里(只看字面,❌ 碰盘)。 */
  allowed(p: string): boolean
  /** 走目录树时进不进这个文件夹:没连上的根不进;~/Library 只在从它里面开始走时才进。 */
  descend(dir: string, start: string): boolean
  /** 根本身(个人文件夹、桌面、文稿、下载):不让移走、替换、扔掉。 */
  isRoot(p: string): boolean
  /** Spotlight 的搜索范围:连上了「其他位置」= 整个个人文件夹(结果再按 allowed 筛),否则 = 连上的那几个根。 */
  searchDirs(): string[]
}

async function scopeOf(granted: ReadonlySet<string>): Promise<Scope> {
  const home = os.homedir()
  const realHome = await fsp.realpath(home).catch(() => home)
  const named = NAMED.map((r) => ({ r, dir: rootDir(r, realHome) }))
  const allowed = (p: string) => {
    const hit = named.find(({ dir }) => within(p, dir))
    return hit ? granted.has(hit.r) : granted.has('files.other') && within(p, realHome)
  }
  const library = path.join(realHome, 'Library')
  const roots = [home, realHome, ...NAMED.flatMap((r) => [rootDir(r, home), rootDir(r, realHome)])].map(lower)
  return {
    home: realHome,
    allowed,
    descend: (dir, start) => allowed(dir) && (!within(dir, library) || within(start, library)),
    isRoot: (p) => roots.includes(lower(path.resolve(p))),
    searchDirs: () => (granted.has('files.other') ? [realHome] : named.filter(({ r }) => granted.has(r)).map(({ dir }) => dir)),
  }
}

/**
 * 要动「这一项本身」的路径(移走、扔掉、复制 / 移到的目标):上级按真实位置判,最后一段照字面 —— 符号链接动的是链接本身,
 * ❌ 顺着去动它指向的东西。根本身不给动。
 */
async function entryPath(raw: string, granted: ReadonlySet<string>, scope: Scope, mustExist: boolean): Promise<Resolved> {
  if (!raw) return { ok: false, message: 'path is required' }
  const refused = lexicalRefusal(raw, granted)
  if (refused) return { ok: false, message: refused }
  const expanded = expandHome(raw)
  if (!path.isAbsolute(expanded)) return { ok: false, message: `path must be absolute (or start with ~/): ${raw}` }
  const abs = path.resolve(expanded)
  const rootRefusal = `${raw} is a connected location itself (the home folder, Desktop, Documents or Downloads); it cannot be moved, replaced or trashed`
  if (scope.isRoot(abs)) return { ok: false, message: rootRefusal }
  const parent = mustExist ? await resolveInsideRoots(path.dirname(abs), granted) : await resolveTargetInsideRoots(path.dirname(abs), granted)
  if (!parent.ok) return { ok: false, message: parent.message.startsWith('not found') ? `not found: ${raw}` : notConnected(raw, granted) }
  const entry = path.join(parent.path, path.basename(abs))
  if (scope.isRoot(entry)) return { ok: false, message: rootRefusal }
  if (!scope.allowed(entry)) return { ok: false, message: notConnected(raw, granted) }
  if (mustExist) {
    try {
      await fsp.lstat(entry)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return { ok: false, message: `not found: ${raw}` }
      throw error
    }
  }
  return { ok: true, path: entry }
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
}

// ───────────────────────── 读写 ─────────────────────────

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 含 NUL、或控制字符超过一成 ⇒ 不是文本。 */
function looksBinary(head: Buffer): boolean {
  if (head.includes(0)) return true
  let control = 0
  for (const b of head) if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++
  return head.length > 0 && control / head.length > 0.1
}

/** 除 \t \n \r 外的控制字符(扩展属性的值是不是能直接给人看的文字)。 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x09 || (c > 0x0d && c < 0x20)) return true
  }
  return false
}

/** 能直接给模型看的图(按文件头认,❌ 只信扩展名)。 */
function imageMime(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

type TextEncoding = 'utf-8' | 'ascii' | 'latin1'
type Encoding = TextEncoding | 'base64'
const ENCODINGS = ['utf-8', 'ascii', 'latin1', 'base64'] as const
const encodingOf = (args: Args): Encoding | undefined | null => {
  const raw = str(args, 'encoding').toLowerCase()
  if (!raw) return undefined
  const value = raw === 'utf8' ? 'utf-8' : raw
  return (ENCODINGS as readonly string[]).includes(value) ? (value as Encoding) : null
}

function decodeText(buffer: Buffer, encoding: TextEncoding): string {
  // 截断处可能把一个汉字切成两半:StringDecoder 只吐完整的字。
  return encoding === 'utf-8' ? new StringDecoder('utf8').write(buffer) : buffer.toString(encoding)
}

/** 从头读到 maxBytes 为止。 */
async function readPrefix(file: string, size: number, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const want = Math.min(size, maxBytes)
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, 0)
    return { buffer: buffer.subarray(0, bytesRead), truncated: size > bytesRead }
  } finally {
    await handle.close()
  }
}

/** 按行取一段(1 起、含两端;边读边数,大文件不整个读进来)。totalLines 只在读到了文件末尾时有。 */
async function readLines(file: string, start: number, end: number | undefined, maxBytes: number) {
  const chunks: Buffer[] = []
  let stored = 0
  let selectedBytes = 0
  let line = 1
  let stoppedEarly = false
  let lastByte = -1
  let lastIncluded = 0
  const take = (part: Buffer) => {
    if (part.length === 0) return
    selectedBytes += part.length
    lastIncluded = line
    const room = maxBytes - stored
    if (room <= 0) return
    const kept = part.subarray(0, room)
    chunks.push(kept)
    stored += kept.length
  }
  const selected = () => line >= start && (end === undefined || line <= end)
  outer: for await (const raw of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const chunk = raw as Buffer
    let from = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue
      if (selected()) take(chunk.subarray(from, i + 1))
      if ((end !== undefined && line >= end) || selectedBytes > maxBytes) {
        stoppedEarly = true
        break outer
      }
      line++
      from = i + 1
    }
    if (selected()) take(chunk.subarray(from))
    if (chunk.length > 0) lastByte = chunk[chunk.length - 1]
    if (selectedBytes > maxBytes) {
      stoppedEarly = true
      break
    }
  }
  const totalLines = stoppedEarly ? null : lastByte === -1 ? 0 : lastByte === 0x0a ? line - 1 : line
  return { buffer: Buffer.concat(chunks, stored), truncated: selectedBytes > maxBytes, totalLines, lastLine: lastIncluded }
}

/**
 * 原子地换掉一个已有文件的内容:先在同一个文件夹里克隆一份(`cp -c -p`:APFS 上瞬间完成,带着原文件的权限与扩展属性 ——
 * Finder 标签、下载来源……),写进新内容,再一步换过去。写到一半断电也不会留下半个文件,标签也不丢。
 * ❌ fs.copyFile:Node 的复制不带扩展属性(2026-10-15 本机实测 libuv 1.51,COPYFILE_FICLONE 也不带)。
 * 克隆、复制都不成(比如文件属于别的用户,-p 改不了属主)时退到只保留权限位,并在结果里说 metadataKept: false。
 */
async function replaceContents(ctx: ActionRunContext, file: string, data: Buffer): Promise<{ metadataKept: boolean }> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.gugu-${randomUUID().slice(0, 8)}.tmp`)
  try {
    let kept = false
    for (const flags of [['-c', '-p'], ['-p']]) {
      if ((await ctx.deps.exec('/bin/cp', [...flags, file, tmp], { signal: ctx.signal, timeoutMs: 120_000 })).code === 0) {
        kept = true
        break
      }
      await fsp.rm(tmp, { force: true })
    }
    const mode = kept ? null : (await fsp.stat(file)).mode & 0o7777
    await fsp.writeFile(tmp, data)
    if (mode !== null) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, file)
    return { metadataKept: kept }
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 名字过滤:* ? 与 {a,b},不分大小写。 */
function globRegex(pattern: string): RegExp {
  let out = ''
  let depth = 0
  for (const ch of pattern) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else if (ch === '{') {
      out += '('
      depth++
    } else if (ch === '}' && depth > 0) {
      out += ')'
      depth--
    } else if (ch === ',' && depth > 0) out += '|'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  if (depth !== 0) throw new Error('unbalanced {')
  return new RegExp(`^${out}$`, 'i')
}

function occurrences(text: string, search: string): number[] {
  const at: number[] = []
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) at.push(i)
  return at
}

/** 一处替换的前后对照(按整行):`@@ line N @@`、`-` 旧行、`+` 新行。 */
function hunk(text: string, index: number, length: number, replacement: string): string {
  const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1
  const endBreak = text.indexOf('\n', index + length)
  const lineEnd = endBreak === -1 ? text.length : endBreak
  const before = text.slice(lineStart, lineEnd)
  const after = before.slice(0, index - lineStart) + replacement + before.slice(index - lineStart + length)
  const lineNo = text.slice(0, lineStart).split('\n').length
  const mark = (prefix: string, block: string) => block.split('\n').map((l) => prefix + l).join('\n')
  return `@@ line ${lineNo} @@\n${mark('-', before)}\n${mark('+', after)}`
}

// ───────────────────────── Spotlight / 命令行 ─────────────────────────

/** mdls -plist 的输出:一层 dict,值是字符串 / 数字 / 日期 / 布尔 / 字符串数组。 */
function parseFlatPlist(xml: string): Record<string, unknown> {
  const decode = (s: string) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
  const scalar = (tag: string, body: string): unknown =>
    tag === 'string' ? decode(body) : tag === 'date' ? isoLocal(new Date(body)) : tag === 'integer' || tag === 'real' ? Number(body) : null
  const out: Record<string, unknown> = {}
  const entry = /<key>([^<]*)<\/key>\s*(?:<(string|integer|real|date)>([\s\S]*?)<\/\2>|<(true|false)\/>|<string\/>|<array>([\s\S]*?)<\/array>|<array\/>|<data>[\s\S]*?<\/data>)/g
  for (const m of xml.matchAll(entry)) {
    const key = decode(m[1])
    if (m[2]) out[key] = scalar(m[2], m[3])
    else if (m[4]) out[key] = m[4] === 'true'
    else if (m[5] !== undefined) out[key] = [...m[5].matchAll(/<(string|integer|real|date)>([\s\S]*?)<\/\1>/g)].map((i) => scalar(i[1], i[2]))
    else if (m[0].includes('<string/>')) out[key] = ''
    else if (m[0].includes('<array/>')) out[key] = []
  }
  return out
}

/** MDQuery 字符串里的引号与反斜杠。 */
const mdq = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const MDQUERY = /kMD\w+\s*[=!<>]/

/** kind → 内容类型(按 UTI 判,❌ 按 kMDItemKind:那是本地化的「PDF 文稿」「PNG 图像」,中文系统上搜 image 什么也找不到)。 */
const KIND_TYPES: Record<string, string[]> = {
  image: ['public.image'],
  pdf: ['com.adobe.pdf'],
  document: ['org.openxmlformats.wordprocessingml.document', 'com.microsoft.word.doc', 'com.apple.iwork.pages.sffpages', 'com.apple.iwork.pages.pages', 'public.rtf', 'com.apple.rtfd', 'org.oasis-open.opendocument.text'],
  presentation: ['public.presentation'],
  spreadsheet: ['public.spreadsheet'],
  movie: ['public.movie'],
  video: ['public.movie'],
  music: ['public.audio'],
  audio: ['public.audio'],
  folder: ['public.folder'],
  archive: ['public.archive'],
  text: ['public.text'],
  code: ['public.source-code'],
}

function kindClause(kind: string): string {
  const types = KIND_TYPES[kind.toLowerCase()]
  if (!types) return `kMDItemKind == "*${mdq(kind)}*"cd`
  return `(${types.map((t) => `kMDItemContentTypeTree == "${t}"`).join(' || ')})`
}

/** 噪音名单:开发 / 系统缓存这些人一般不想要的地方。 */
const NOISE = [
  '/node_modules/', '/.git/', '/.svn/', '/.hg/', '/Library/Caches/', '/Library/Application Support/Google/Chrome/',
  '/Library/Application Support/Firefox/', '/Library/Application Support/Microsoft Edge/', '/Library/Application Support/Arc/',
  '/Library/Application Support/BraveSoftware/', '/Library/Application Support/Code/', '/Library/Application Support/Cursor/',
  '/Library/Group Containers/', '/Library/Developer/', '/.Trash/', '/.npm/', '/.pnpm/', '/.bun/', '/.cargo/', '/.rustup/',
  '/.pyenv/', '/.conda/', '/.venv/', '/venv/', '/__pycache__/', '/.cache/', '/.local/share/', '/dist/', '/build/output/', '/.build/',
]
const isNoise = (p: string) => NOISE.some((seg) => p.includes(seg))

/** 在每个范围里跑一次 mdfind(范围最多三个),合并去重。 */
async function spotlight(ctx: ActionRunContext, dirs: readonly string[], query: string): Promise<string[]> {
  const seen = new Set<string>()
  for (const dir of dirs) {
    const r = await ctx.deps.exec('/usr/bin/mdfind', ['-onlyin', dir, query], { signal: ctx.signal, timeoutMs: 30_000 })
    if (r.code !== 0) throw new Error(`Spotlight search (mdfind) failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
    for (const line of r.stdout.split('\n')) if (line) seen.add(line)
  }
  return [...seen]
}

async function readTags(ctx: ActionRunContext, paths: readonly string[]): Promise<Map<string, Tag[] | { error: string }>> {
  const out = new Map<string, Tag[] | { error: string }>()
  for (let i = 0; i < paths.length; i += 500) {
    const r = await ctx.deps.macHelper().call<{ results: Array<{ path: string; tags?: Tag[]; error?: string }> }>(
      'files.tags.get', { paths: paths.slice(i, i + 500) }, { signal: ctx.signal, timeoutMs: 60_000 })
    for (const row of r.results) out.set(row.path, row.tags ?? { error: row.error ?? 'unreadable' })
  }
  return out
}

async function writeTags(ctx: ActionRunContext, file: string, tags: readonly Tag[]): Promise<Tag[]> {
  const r = await ctx.deps.macHelper().call<{ tags: Tag[] }>('files.tags.set', { path: file, tags }, { signal: ctx.signal, timeoutMs: 30_000 })
  return r.tags
}

/**
 * 让 Spotlight 马上重读这些文件(按标签找、标签总览靠它)。只给文件:mdimport 对文件夹是整棵树重导。
 * 它失败不影响标签本身 —— 标签已经写进文件了,Spotlight 迟早会自己看到。
 */
async function reindex(ctx: ActionRunContext, files: readonly string[]): Promise<void> {
  for (let i = 0; i < files.length; i += 100) {
    await ctx.deps.exec('/usr/bin/mdimport', ['-i', ...files.slice(i, i + 100)], { signal: ctx.signal, timeoutMs: 30_000 }).catch(() => undefined)
  }
}

async function onlyFiles(paths: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) if ((await fsp.lstat(p).catch(() => null))?.isFile()) out.push(p)
  return out
}

/** 解析 tags 参数:字符串或 {name, color}。不对回 null。 */
function tagsArg(value: unknown): Tag[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const out: Tag[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: item.trim(), color: 'none' })
      continue
    }
    if (!item || typeof item !== 'object') return null
    const { name, color = 'none' } = item as { name?: unknown; color?: unknown }
    if (typeof name !== 'string' || !name.trim() || name.includes('\n')) return null
    if (typeof color !== 'string' || !(TAG_COLORS as readonly string[]).includes(color)) return null
    out.push({ name: name.trim(), color })
  }
  return out
}

/** 找 ripgrep:Homebrew / MacPorts / cargo 的位置,再按 PATH(从 Finder 打开的咕咕 PATH 里没有 Homebrew)。 */
async function defaultFindRipgrep(): Promise<string | null> {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', path.join(os.homedir(), '.cargo', 'bin'), ...(process.env.PATH ?? '').split(path.delimiter)]
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    const candidate = path.join(dir, 'rg')
    try {
      await fsp.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // 下一个位置
    }
  }
  return null
}

/** 安全相关的扩展属性:改它 / 删它会改变 macOS 对这个文件的把关(去掉 quarantine = 打开下载来的程序前不再检查)。 */
const SECURITY_XATTRS: Record<string, string> = {
  'com.apple.quarantine': 'macOS 打开这个下载来的文件前做的安全检查',
  'com.apple.provenance': 'macOS 记的这个文件的来源',
  'com.apple.macl': '系统记的哪些 App 可以打开它',
  'com.apple.rootless': '系统完整性保护',
}

// ───────────────────────── 分组 ─────────────────────────

/** 「连接」时真读一次那个文件夹:第一次会弹「允许咕咕访问…文件夹」,读得到才算连上。 */
function probeRoot(root: FileRoot) {
  return async (ctx: FamilyContext): Promise<Outcome> => {
    const home = ctx.deps.homedir()
    const dir = root === 'files.other' ? home : rootDir(root, home)
    try {
      await fsp.readdir(dir)
      return ok(null)
    } catch (error) {
      const code = errnoOf(error)
      if (code === 'EPERM' || code === 'EACCES') {
        return fail('os_permission', root === 'files.other'
          ? `macOS 没让咕咕读个人文件夹（${dir}）：去 系统设置 → 隐私与安全性 → 完全磁盘访问权限 里打开咕咕，再点一次「连接」`
          : `macOS 没允许咕咕访问「${LABEL[root]}」文件夹：去 系统设置 → 隐私与安全性 → 文件与文件夹 → 咕咕，打开「${LABEL[root]}文件夹」，再点一次「连接」`)
      }
      if (code === 'ENOENT') return fail('execution_failed', `这台电脑上没有「${LABEL[root]}」文件夹（${dir}）`)
      return fail('execution_failed', `读不了「${LABEL[root]}」文件夹：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function rootGroup(root: FileRoot): ActionGroupDef {
  const other = root === 'files.other'
  return {
    id: root,
    platforms: ['darwin'],
    section: 'files',
    settingsUrl: MAC_PRIVACY(other ? 'Privacy_AllFiles' : 'Privacy_FilesAndFolders'),
    osPermission: other
      ? '系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 打开咕咕（个人文件夹里受保护的地方才需要）'
      : `系统设置 → 隐私与安全性 → 文件与文件夹 → 咕咕 → 打开「${LABEL[root]}文件夹」`,
    probe: probeRoot(root),
  }
}

// ───────────────────────── 动作 ─────────────────────────

export function createFilesFamily(options: { findRipgrep?: () => Promise<string | null> } = {}): ActionFamily {
  const findRipgrep = options.findRipgrep ?? defaultFindRipgrep

  const list = fileAction({
    name: 'fs.list',
    title: '列目录',
    titleEn: 'List folder',
    description: 'List a folder: each entry\'s name, type (file / directory / symlink), size (files) and modified time (local, with offset). sortBy name (default, folders first), size (largest first) or modified (newest first). recursive walks subfolders up to maxDepth (default 5) and adds each entry\'s absolute path; it never follows symlinks and does not enter locations that are not connected (marked notConnected) or ~/Library unless you list inside it. pattern filters names with a glob (*.pdf, IMG_????.{jpg,heic}). Dot files only with showHidden. Stops after ~20 s or 10,000 entries with truncated: true — then narrow path, pattern or maxDepth. Returns up to limit entries (default 200, max 500) plus total.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: `Folder to list. ${PATH_DOC}` },
        recursive: { type: 'boolean', description: 'Also list subfolders (default false)' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 20, description: 'How deep recursive goes (default 5)' },
        pattern: { type: 'string', description: 'Glob on the entry name, case-insensitive: * ? {a,b}' },
        showHidden: { type: 'boolean', description: 'Include names starting with . (default false)' },
        sortBy: { type: 'string', enum: ['name', 'size', 'modified'] },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max entries returned (default 200)' },
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      const pattern = str(args, 'pattern')
      if (pattern) {
        try {
          globRegex(pattern)
        } catch {
          return `pattern is not a valid glob: ${pattern}`
        }
      }
      const sortBy = str(args, 'sortBy')
      return sortBy && !['name', 'size', 'modified'].includes(sortBy) ? 'sortBy must be name, size or modified' : null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const granted = ctx.granted()
      const where = await existingPath(raw, granted)
      if (!where.ok) return bad(where.message)
      if (!(await fsp.stat(where.path)).isDirectory()) return bad(`${raw} is a file, not a folder: use fs.read or fs.stat`)
      const scope = await scopeOf(granted)
      const recursive = bool(args, 'recursive') === true
      const maxDepth = clampInt(num(args, 'maxDepth'), 5, 1, 20)
      const limit = clampInt(num(args, 'limit'), 200, 1, 500)
      const showHidden = bool(args, 'showHidden') === true
      const pattern = str(args, 'pattern') ? globRegex(str(args, 'pattern')) : null
      const deadline = Date.now() + LIST_BUDGET_MS
      const rows: Array<{ row: Record<string, unknown>; dir: boolean; size: number; mtime: number; name: string }> = []
      let stopped = false
      let skipped = 0
      const walk = async (dir: string, depth: number): Promise<void> => {
        let names: string[]
        try {
          names = await fsp.readdir(dir)
        } catch (error) {
          if (depth === 1) throw error
          skipped++
          return
        }
        for (const name of names) {
          if (Date.now() > deadline || rows.length >= LIST_HARD_CAP || ctx.signal.aborted) {
            stopped = true
            return
          }
          if (!showHidden && name.startsWith('.')) continue
          const full = path.join(dir, name)
          const st = await fsp.lstat(full).catch(() => null)
          if (!st) continue
          const type = typeOf(st)
          const blocked = type === 'directory' && !scope.allowed(full)
          if (!pattern || pattern.test(name)) {
            rows.push({
              name,
              dir: type === 'directory',
              size: st.size,
              mtime: st.mtimeMs,
              row: {
                name,
                ...(recursive ? { path: full } : {}),
                type,
                ...(type === 'file' ? { size: st.size } : {}),
                modified: isoLocal(st.mtime),
                ...(blocked ? { notConnected: true } : {}),
              },
            })
          }
          if (recursive && type === 'directory' && depth < maxDepth) {
            if (scope.descend(full, where.path)) await walk(full, depth + 1)
            else skipped++
          }
        }
      }
      await walk(where.path, 1)
      const sortBy = str(args, 'sortBy') || 'name'
      rows.sort(sortBy === 'size' ? (a, b) => b.size - a.size
        : sortBy === 'modified' ? (a, b) => b.mtime - a.mtime
        : (a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1))
      return ok({
        path: where.path,
        total: rows.length,
        entries: rows.slice(0, limit).map((r) => r.row),
        truncated: stopped || rows.length > limit,
        ...(stopped ? { note: `stopped early (20 s or ${LIST_HARD_CAP} entries); total counts only what was seen — narrow path, pattern or maxDepth` } : {}),
        ...(skipped > 0 ? { skippedFolders: skipped } : {}),
      })
    },
  })

  const read = fileAction({
    name: 'fs.read',
    title: '读文件',
    titleEn: 'Read file',
    description: 'Read a file. Text comes back as content (default up to 128 KB, maxBytes up to 1 MB; truncated: true when cut) with lines = total line count when read to the end. lineStart / lineEnd (1-based, inclusive) read just those lines of a large file. A PNG / JPEG / GIF / WebP image up to 5 MB, with encoding omitted, comes back as a picture you can see. Other binary files are refused unless encoding is "base64" (default up to 256 KB, max 4 MB). For text inside images, scans or PDFs use fs.ocr.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        encoding: { type: 'string', enum: [...ENCODINGS], description: 'Omit for auto (text as UTF-8, images as pictures); "base64" for raw bytes' },
        lineStart: { type: 'integer', minimum: 1 },
        lineEnd: { type: 'integer', minimum: 1 },
        maxBytes: { type: 'integer', minimum: 1, description: 'Cap on bytes returned (text max 1 MB, base64 max 4 MB)' },
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      if (encodingOf(args) === null) return `encoding must be one of ${ENCODINGS.join(', ')}`
      const start = num(args, 'lineStart')
      const end = num(args, 'lineEnd')
      if ((start !== undefined && start < 1) || (end !== undefined && end < 1)) return 'lineStart / lineEnd start at 1'
      if (start !== undefined && end !== undefined && end < start) return 'lineEnd must be >= lineStart'
      if (encodingOf(args) === 'base64' && (start !== undefined || end !== undefined)) return 'lineStart / lineEnd only work for text, not base64'
      return null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const st = await fsp.stat(where.path)
      if (st.isDirectory()) return bad(`${raw} is a folder: use fs.list`)
      let encoding = encodingOf(args) ?? undefined
      const lineStart = num(args, 'lineStart')
      const lineEnd = num(args, 'lineEnd')
      if (encoding === undefined) {
        const head = await readHead(where.path, 8192)
        const mime = imageMime(head)
        if (mime && lineStart === undefined && lineEnd === undefined) {
          if (st.size > PICTURE_MAX) {
            return ok({ path: where.path, size: st.size, mimeType: mime, note: `image larger than ${sizeText(PICTURE_MAX)}, not attached: use fs.ocr for its text, or encoding "base64" with maxBytes` })
          }
          const data = await fsp.readFile(where.path)
          return ok({ path: where.path, size: st.size, mimeType: mime, pictures: [{ label: path.basename(where.path), mimeType: mime, data: data.toString('base64') }] })
        }
        if (looksBinary(head)) {
          return bad(`${raw} is a binary file (${sizeText(st.size)}${mime ? `, ${mime}` : ''}): read it with encoding "base64", use fs.ocr for images / scans / PDFs, or fs.stat for its metadata`)
        }
        encoding = 'utf-8'
      }
      if (encoding === 'base64') {
        const maxBytes = clampInt(num(args, 'maxBytes'), READ_B64_DEFAULT, 1, READ_B64_MAX)
        const { buffer, truncated } = await readPrefix(where.path, st.size, maxBytes)
        return ok({ path: where.path, size: st.size, encoding, content: buffer.toString('base64'), truncated })
      }
      const maxBytes = clampInt(num(args, 'maxBytes'), READ_TEXT_DEFAULT, 1, READ_TEXT_MAX)
      if (lineStart === undefined && lineEnd === undefined && st.size <= maxBytes) {
        const buffer = await fsp.readFile(where.path)
        const text = decodeText(buffer, encoding)
        const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        return ok({ path: where.path, size: st.size, content: text, lines, truncated: false })
      }
      const r = await readLines(where.path, lineStart ?? 1, lineEnd, maxBytes)
      return ok({
        path: where.path,
        size: st.size,
        content: decodeText(r.buffer, encoding),
        lines: r.totalLines,
        ...(lineStart !== undefined || lineEnd !== undefined ? { lineStart: lineStart ?? 1, lineEnd: r.lastLine } : {}),
        truncated: r.truncated,
        ...(r.truncated ? { note: 'cut at maxBytes: read further with lineStart / lineEnd' } : {}),
      })
    },
  })

  const write = fileAction({
    name: 'fs.write',
    title: '写文件',
    titleEn: 'Write file',
    description: 'Write a file. mode "overwrite" (default) replaces the content atomically and keeps the file\'s permissions and Finder tags; replacing a file that already exists first returns needs_confirmation (call again with confirmed: true once the person agrees). "append" adds to the end (creates the file if missing), "create" refuses if the file exists. Missing parent folders are created unless createDirectories is false. content is text (utf-8 / ascii / latin1) or base64 with encoding "base64"; at most 20 MB.',
    risk: 'medium',
    confirm: 'on_conflict',
    input_schema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        content: { type: 'string' },
        encoding: { type: 'string', enum: [...ENCODINGS], description: 'How content is encoded (default utf-8)' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'create'] },
        createDirectories: { type: 'boolean', description: 'Create missing parent folders (default true)' },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      if (typeof args.content !== 'string') return 'content must be a string'
      if (encodingOf(args) === null) return `encoding must be one of ${ENCODINGS.join(', ')}`
      const mode = str(args, 'mode')
      if (mode && !['overwrite', 'append', 'create'].includes(mode)) return 'mode must be overwrite, append or create'
      return args.content.length > WRITE_MAX * 2 ? 'content is larger than 20 MB' : null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await targetPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const encoding = encodingOf(args) ?? 'utf-8'
      const data = Buffer.from(args.content as string, encoding === 'utf-8' ? 'utf8' : encoding)
      if (data.length > WRITE_MAX) return bad('content is larger than 20 MB')
      const mode = str(args, 'mode') || 'overwrite'
      const existing = await lstatOrNull(where.path)
      if (existing?.isDirectory()) return bad(`${raw} is a folder`)
      if (existing && mode === 'create') return bad(`${raw} already exists: use mode "overwrite" (the person will be asked first) or "append"`)
      if (existing && mode === 'overwrite' && args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
        return askFirst(
          `${where.path} already exists (${sizeText(existing.size)}). Ask the person, then call again with confirmed: true to replace it.`,
          `要覆盖「${where.path}」吗？现有 ${sizeText(existing.size)}（${isoLocal(existing.mtime)} 改过），会换成新的 ${sizeText(data.length)}。`,
          { path: where.path, existingSize: existing.size, existingModified: isoLocal(existing.mtime), newSize: data.length },
        )
      }
      if (!existing) {
        const parent = path.dirname(where.path)
        const pst = await lstatOrNull(parent)
        if (!pst) {
          if (bool(args, 'createDirectories') === false) return bad(`folder ${parent} does not exist: pass createDirectories: true or create it with fs.mkdir`)
          await fsp.mkdir(parent, { recursive: true })
        } else if (!pst.isDirectory()) return bad(`${parent} is a file, not a folder`)
      }
      let metadataKept = true
      if (mode === 'append') await fsp.appendFile(where.path, data)
      else if (existing) metadataKept = (await replaceContents(ctx, where.path, data)).metadataKept
      // 新文件:wx = 恰好在这一刻别人也建了它就报错,❌ 悄悄盖掉。
      else await fsp.writeFile(where.path, data, { flag: 'wx' })
      return ok({ path: where.path, bytesWritten: data.length, created: !existing, mode, ...(metadataKept ? {} : { metadataKept: false }) })
    },
  })

  const patch = fileAction({
    name: 'fs.patch',
    title: '改文件',
    titleEn: 'Edit file',
    description: 'Edit a text file by exact search-and-replace. edits apply in order (later ones see earlier results). Each search must match exactly once — add surrounding text to make it unique — unless replaceAll is true. All-or-nothing: if any edit does not match, nothing is written and the error says which. Returns a line-based diff of what changed (or would change with dryRun: true). Keeps the file\'s permissions and Finder tags. UTF-8 text files up to 10 MB.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path', 'edits'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['search', 'replace'],
            properties: {
              search: { type: 'string', description: 'Exact text to find (whitespace and line breaks included)' },
              replace: { type: 'string' },
              replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
            },
            additionalProperties: false,
          },
        },
        dryRun: { type: 'boolean', description: 'Only show the diff, write nothing' },
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > 100) return 'edits must be a list of 1–100 {search, replace}'
      for (const [i, e] of (args.edits as unknown[]).entries()) {
        const edit = e as { search?: unknown; replace?: unknown } | null
        if (!edit || typeof edit.search !== 'string' || edit.search.length === 0) return `edits[${i}].search must be non-empty text`
        if (typeof edit.replace !== 'string') return `edits[${i}].replace must be text`
      }
      return null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const st = await fsp.stat(where.path)
      if (st.isDirectory()) return bad(`${raw} is a folder`)
      if (st.size > PATCH_MAX) return bad(`${raw} is larger than 10 MB: fs.patch only edits smaller text files`)
      const buffer = await fsp.readFile(where.path)
      if (looksBinary(buffer.subarray(0, 8192))) return bad(`${raw} is not a text file`)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        return bad(`${raw} is not UTF-8 text: editing it would corrupt it`)
      }
      const edits = args.edits as Array<{ search: string; replace: string; replaceAll?: boolean }>
      const results: Array<Record<string, unknown>> = []
      const problems: string[] = []
      const hunks: string[] = []
      for (const [i, edit] of edits.entries()) {
        const at = occurrences(text, edit.search)
        const label = edit.search.length > 60 ? `${edit.search.slice(0, 60)}…` : edit.search
        if (at.length === 0) {
          problems.push(`edits[${i}] (${JSON.stringify(label)}) was not found`)
          results.push({ search: label, applied: false, count: 0 })
          continue
        }
        if (at.length > 1 && edit.replaceAll !== true) {
          problems.push(`edits[${i}] (${JSON.stringify(label)}) matches ${at.length} times: add surrounding text so it matches once, or set replaceAll: true`)
          results.push({ search: label, applied: false, count: at.length })
          continue
        }
        for (const index of at) hunks.push(hunk(text, index, edit.search.length, edit.replace))
        text = text.split(edit.search).join(edit.replace)
        results.push({ search: label, applied: true, count: at.length })
      }
      if (problems.length > 0) return bad(`Nothing was written. ${problems.join('; ')}.`)
      let diff = hunks.join('\n')
      const diffTruncated = diff.length > DIFF_MAX
      if (diffTruncated) diff = `${diff.slice(0, DIFF_MAX)}\n…`
      const dryRun = bool(args, 'dryRun') === true
      const kept = dryRun ? true : (await replaceContents(ctx, where.path, Buffer.from(text, 'utf8'))).metadataKept
      return ok({ path: where.path, written: !dryRun, dryRun, edits: results, diff, ...(diffTruncated ? { diffTruncated: true } : {}), ...(kept ? {} : { metadataKept: false }) })
    },
  })

  const mkdir = fileAction({
    name: 'fs.mkdir',
    title: '建文件夹',
    titleEn: 'Create folder',
    description: 'Create a folder (and missing parent folders unless recursive is false). Already existing is fine: alreadyExisted: true.',
    risk: 'low',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: PATH_DOC }, recursive: { type: 'boolean', description: 'Create missing parents (default true)' } },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'path') ? null : 'path is required'),
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await targetPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const existing = await lstatOrNull(where.path)
      if (existing) return existing.isDirectory() ? ok({ path: where.path, alreadyExisted: true }) : bad(`${raw} exists and is not a folder`)
      try {
        await fsp.mkdir(where.path, { recursive: bool(args, 'recursive') !== false })
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return bad(`the parent folder of ${raw} does not exist: pass recursive: true`)
        throw error
      }
      return ok({ path: where.path, alreadyExisted: false })
    },
  })

  /** 目标已经有东西:没说 overwrite 就拒;说了也先问人(被替换的进废纸篓)。 */
  const conflict = (args: Args, verb: string, from: string, to: string, existing: fs.Stats): Outcome | null => {
    if (args.overwrite !== true) return bad(`${to} already exists. To replace it, call again with overwrite: true (the person will be asked first; the replaced item goes to the Trash).`)
    if (args[DEVICE_ACTION_CONFIRMED_ARG] === true) return null
    return askFirst(
      `${to} already exists. Ask the person, then call again with overwrite: true and confirmed: true.`,
      `「${to}」已经有了${existing.isDirectory() ? '（是个文件夹）' : `（${sizeText(existing.size)}）`}，要用${verb}的「${from}」替换它吗？被替换的那个会移到废纸篓。`,
      { source: from, destination: to, destinationType: typeOf(existing) },
    )
  }

  const move = fileAction({
    name: 'fs.move',
    title: '移动或改名',
    titleEn: 'Move or rename',
    description: 'Move or rename a file or folder: destination is the full new path (not a folder to drop it into). If destination already exists it is refused unless overwrite is true, and then needs_confirmation first; the replaced item goes to the Trash. A symlink is moved itself, not what it points to. The connected locations themselves (Desktop, Documents, Downloads, home) cannot be moved. The destination folder must exist (fs.mkdir).',
    risk: 'medium',
    confirm: 'on_conflict',
    input_schema: {
      type: 'object',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string', description: PATH_DOC },
        destination: { type: 'string', description: 'Full new path' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination (asks the person first)' },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'source') && str(args, 'destination') ? null : 'source and destination are required'),
    async run(args, ctx) {
      const granted = ctx.granted()
      const scope = await scopeOf(granted)
      const src = await entryPath(str(args, 'source'), granted, scope, true)
      if (!src.ok) return bad(src.message)
      const dst = await entryPath(str(args, 'destination'), granted, scope, false)
      if (!dst.ok) return bad(dst.message)
      if (dst.path === src.path) return bad('source and destination are the same')
      if (dst.path.startsWith(src.path + path.sep)) return bad('cannot move a folder into itself')
      const srcStat = await fsp.lstat(src.path)
      const existing = await lstatOrNull(dst.path)
      // 只改大小写(a.txt → A.txt):目标「存在」其实就是它自己。
      const same = existing !== null && existing.ino === srcStat.ino && existing.dev === srcStat.dev
      if (existing && !same) {
        const stop = conflict(args, '移过来', src.path, dst.path, existing)
        if (stop) return stop
      }
      const parent = await lstatOrNull(path.dirname(dst.path))
      if (!parent?.isDirectory()) return bad(`folder ${path.dirname(dst.path)} does not exist: create it with fs.mkdir first`)
      if (existing && !same) await ctx.deps.trashItem(dst.path)
      try {
        await fsp.rename(src.path, dst.path)
      } catch (error) {
        if (errnoOf(error) !== 'EXDEV') throw error
        // 跨磁盘:rename 做不到,交给 mv(复制再删)。
        ctx.note('正在跨磁盘移动…')
        const r = await ctx.deps.exec('/bin/mv', ['--', src.path, dst.path], { signal: ctx.signal, timeoutMs: 280_000 })
        if (r.code !== 0) return fail('execution_failed', `mv failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
      }
      return ok({ source: src.path, destination: dst.path, replaced: existing !== null && !same })
    },
  })

  const copy = fileAction({
    name: 'fs.copy',
    title: '复制',
    titleEn: 'Copy',
    description: 'Copy a file or folder to destination (the full path of the copy). Folders copy recursively (recursive: false refuses folders). clone (default true) makes an instant, space-free APFS copy and falls back to a normal copy on other volumes; times and Finder tags are kept, symlinks inside are copied as links. If destination exists it is refused unless overwrite is true, and then needs_confirmation first; the replaced item goes to the Trash.',
    risk: 'medium',
    confirm: 'on_conflict',
    input_schema: {
      type: 'object',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string', description: PATH_DOC },
        destination: { type: 'string', description: 'Full path of the copy' },
        recursive: { type: 'boolean', description: 'Allow copying folders (default true)' },
        clone: { type: 'boolean', description: 'APFS copy-on-write clone when possible (default true)' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination (asks the person first)' },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'source') && str(args, 'destination') ? null : 'source and destination are required'),
    async run(args, ctx) {
      const granted = ctx.granted()
      const scope = await scopeOf(granted)
      const src = await existingPath(str(args, 'source'), granted)
      if (!src.ok) return bad(src.message)
      // 整个个人文件夹里有没连上的根:❌ 整个复制。
      if (lower(src.path) === lower(scope.home)) return bad('cannot copy the whole home folder: copy the folders inside it instead')
      const dst = await entryPath(str(args, 'destination'), granted, scope, false)
      if (!dst.ok) return bad(dst.message)
      if (dst.path === src.path) return bad('source and destination are the same')
      if (dst.path.startsWith(src.path + path.sep)) return bad('cannot copy a folder into itself')
      const isDir = (await fsp.stat(src.path)).isDirectory()
      if (isDir && bool(args, 'recursive') === false) return bad(`${str(args, 'source')} is a folder: pass recursive: true to copy it`)
      const existing = await lstatOrNull(dst.path)
      if (existing) {
        const stop = conflict(args, '复制过来', src.path, dst.path, existing)
        if (stop) return stop
      }
      const parent = await lstatOrNull(path.dirname(dst.path))
      if (!parent?.isDirectory()) return bad(`folder ${path.dirname(dst.path)} does not exist: create it with fs.mkdir first`)
      if (existing) await ctx.deps.trashItem(dst.path)
      const flags = isDir ? ['-p', '-R'] : ['-p']
      const cp = (extra: string[]) => ctx.deps.exec('/bin/cp', [...extra, ...flags, src.path, dst.path], { signal: ctx.signal, timeoutMs: 280_000 })
      if (isDir) ctx.note('正在复制文件夹…')
      let cloned = false
      if (bool(args, 'clone') !== false) {
        cloned = (await cp(['-c'])).code === 0
        // 不是 APFS / 跨磁盘克隆不了:清掉克隆到一半的(目标原本不存在,是这次建的),再普通复制。
        if (!cloned) await fsp.rm(dst.path, { recursive: true, force: true })
      }
      if (!cloned) {
        const r = await cp([])
        if (r.code !== 0) return fail('execution_failed', `cp failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
      }
      return ok({ source: src.path, destination: dst.path, cloned, replaced: existing !== null })
    },
  })

  const trashPaths = (args: Args): string[] => {
    const value = args.path
    const list = Array.isArray(value) ? value : [value]
    return [...new Set(list.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean))]
  }

  const trash = fileAction({
    name: 'fs.trash',
    title: '移到废纸篓',
    titleEn: 'Move to Trash',
    description: 'Move files or folders to the Trash (the only way to delete; the person can put them back from the Trash). path is one path or a list of up to 100. Always needs the person\'s confirmation first: without confirmed: true it returns needs_confirmation naming exactly what will be trashed. If any path is outside the connected locations, nothing is trashed. A symlink is trashed itself, not what it points to; the connected locations themselves cannot be trashed.',
    risk: 'high',
    confirm: 'always',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }],
          description: 'One path or a list of paths',
        },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate(args) {
      const value = args.path
      if (Array.isArray(value) ? value.length === 0 || value.length > 100 || value.some((p) => typeof p !== 'string' || !p.trim()) : typeof value !== 'string' || !value.trim()) {
        return 'path must be a path or a list of 1–100 paths'
      }
      return null
    },
    question(args) {
      const paths = trashPaths(args)
      if (paths.length === 1) return `要把「${paths[0]}」移到废纸篓吗？`
      const shown = paths.slice(0, 10).map((p) => `· ${p}`).join('\n')
      return `要把这 ${paths.length} 项移到废纸篓吗？\n${shown}${paths.length > 10 ? `\n…等共 ${paths.length} 项` : ''}`
    },
    async run(args, ctx) {
      const granted = ctx.granted()
      const scope = await scopeOf(granted)
      const resolved: string[] = []
      const refused: string[] = []
      for (const raw of trashPaths(args)) {
        const r = await entryPath(raw, granted, scope, true)
        if (r.ok) resolved.push(r.path)
        else refused.push(r.message)
      }
      if (refused.length > 0) return bad(`Nothing was trashed. ${refused.join('; ')}`)
      const trashed: string[] = []
      const errors: string[] = []
      for (const p of resolved) {
        try {
          await ctx.deps.trashItem(p)
          trashed.push(p)
        } catch (error) {
          errors.push(`${p}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (trashed.length === 0) return fail('execution_failed', `Nothing was trashed: ${errors.join('; ')}`)
      return ok({ trashed, ...(errors.length > 0 ? { errors } : {}) })
    },
  })

  const stat = fileAction({
    name: 'fs.stat',
    title: '看文件信息',
    titleEn: 'File info',
    description: 'Details of a file or folder: type, size, created / modified / accessed (local time with offset), mode, owner ids, inode, link count, hidden; linkTarget when the given path is a symlink. spotlight: true adds Spotlight metadata: content type, kind, Finder tags, where it was downloaded from, Finder comment, last opened, pixel size, duration, page count, title, authors (whatever applies).',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: PATH_DOC }, spotlight: { type: 'boolean', description: 'Include Spotlight metadata (default false)' } },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'path') ? null : 'path is required'),
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const given = path.resolve(expandHome(raw))
      const link = await fsp.lstat(given).catch(() => null)
      const st = await fsp.stat(where.path)
      const data: Record<string, unknown> = {
        path: where.path,
        ...(link?.isSymbolicLink() ? { linkPath: given, linkTarget: await fsp.readlink(given) } : {}),
        type: typeOf(st),
        size: st.size,
        created: isoLocal(st.birthtime),
        modified: isoLocal(st.mtime),
        accessed: isoLocal(st.atime),
        mode: `0${(st.mode & 0o7777).toString(8)}`,
        uid: st.uid,
        gid: st.gid,
        inode: st.ino,
        links: st.nlink,
        isHidden: path.basename(where.path).startsWith('.'),
      }
      if (bool(args, 'spotlight') === true) {
        const r = await ctx.deps.exec('/usr/bin/mdls', ['-plist', '-', where.path], { signal: ctx.signal, timeoutMs: 15_000 })
        if (r.code !== 0) {
          data.spotlight = null
          data.spotlightError = (r.stderr || r.stdout).trim().slice(0, 300) || `mdls exited ${r.code}`
        } else {
          const md = parseFlatPlist(r.stdout)
          const pick: Record<string, string> = {
            contentType: 'kMDItemContentType', kind: 'kMDItemKind', whereFrom: 'kMDItemWhereFroms', finderComment: 'kMDItemFinderComment',
            lastOpened: 'kMDItemLastUsedDate', pixelWidth: 'kMDItemPixelWidth', pixelHeight: 'kMDItemPixelHeight', durationSeconds: 'kMDItemDurationSeconds',
            pages: 'kMDItemNumberOfPages', title: 'kMDItemTitle', authors: 'kMDItemAuthors',
          }
          const spot: Record<string, unknown> = {}
          for (const [k, key] of Object.entries(pick)) if (md[key] !== undefined && md[key] !== null) spot[k] = md[key]
          spot.tags = md.kMDItemUserTags ?? md._kMDItemUserTags ?? []
          data.spotlight = spot
        }
      }
      return ok(data)
    },
  })

  const find = fileAction({
    name: 'fs.find',
    title: '找文件',
    titleEn: 'Find files',
    description: 'Find files with Spotlight, only inside the connected locations (or inside directory). name: file name, case-insensitive substring, or a glob with * ? ("*.pdf", "IMG_*"). query: full-text and metadata search — best for personal files with meaningless names; combine with kind ("身份证" + kind image). Raw MDQuery also works (kMDItemAuthors == "Li"). kind: image, pdf, document, presentation, spreadsheet, movie, music, folder, archive, text, code. tag: Finder tag name. Noise (node_modules, .git, caches…) is filtered unless excludeNoise is false. Returns up to limit results (default 50, max 500) with type, size, modified. Spotlight does not OCR photos on disk: if a query finds nothing, list likely folders and use fs.ocr.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name substring or glob' },
        query: { type: 'string', description: 'Full-text / metadata search, or an MDQuery expression' },
        kind: { type: 'string', description: 'image, pdf, document, presentation, spreadsheet, movie, music, folder, archive, text, code' },
        tag: { type: 'string', description: 'Finder tag name' },
        directory: { type: 'string', description: `Only search inside this folder. ${PATH_DOC}` },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        excludeNoise: { type: 'boolean', description: 'Drop developer / cache paths (default true)' },
      },
      additionalProperties: false,
    },
    validate: (args) => (str(args, 'name') || str(args, 'query') || str(args, 'tag') || str(args, 'kind') ? null : 'give at least one of name, query, kind or tag (for personal files: query + kind)'),
    async run(args, ctx) {
      const granted = ctx.granted()
      const scope = await scopeOf(granted)
      let dirs = scope.searchDirs()
      if (str(args, 'directory')) {
        const where = await existingPath(str(args, 'directory'), granted)
        if (!where.ok) return bad(where.message)
        if (!(await fsp.stat(where.path)).isDirectory()) return bad(`${str(args, 'directory')} is not a folder`)
        dirs = [where.path]
      }
      const name = str(args, 'name')
      const query = str(args, 'query')
      const tag = str(args, 'tag')
      const kind = str(args, 'kind')
      let q: string
      if (query && !name && !tag && !kind) q = query
      else {
        const parts: string[] = []
        if (query) parts.push(MDQUERY.test(query) ? `(${query})` : `(kMDItemTextContent == "*${mdq(query)}*"cd || kMDItemFSName == "*${mdq(query)}*"cd)`)
        if (name) parts.push(`kMDItemFSName == "${/[*?]/.test(name) ? mdq(name) : `*${mdq(name)}*`}"cd`)
        if (tag) parts.push(`kMDItemUserTags == "${mdq(tag)}"cd`)
        if (kind) parts.push(kindClause(kind))
        q = parts.join(' && ')
      }
      const found = (await spotlight(ctx, dirs, q)).filter(scope.allowed)
      const kept = bool(args, 'excludeNoise') === false ? found : found.filter((p) => !isNoise(p))
      // 个人常放东西的地方排前面。
      const priority = ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies', 'Music'].map((d) => path.join(scope.home, d))
      const score = (p: string) => (priority.some((d) => within(p, d)) ? 2 : within(p, path.join(scope.home, 'Library')) ? 0 : 1)
      kept.sort((a, b) => score(b) - score(a))
      const limit = clampInt(num(args, 'limit'), 50, 1, 500)
      const results: Array<Record<string, unknown>> = []
      for (const p of kept.slice(0, limit)) {
        const st = await fsp.lstat(p).catch(() => null)
        results.push(st ? { path: p, type: typeOf(st), ...(st.isFile() ? { size: st.size } : {}), modified: isoLocal(st.mtime) } : { path: p })
      }
      return ok({ total: kept.length, results, truncated: kept.length > limit, ...(found.length !== kept.length ? { filteredOut: found.length - kept.length } : {}), searched: dirs })
    },
  })

  const grep = fileAction({
    name: 'fs.grep',
    title: '搜文件内容',
    titleEn: 'Search file contents',
    description: 'Search inside text files under path with ripgrep (needs ripgrep installed on this computer; otherwise returns unsupported — then use fs.find with query). pattern is a regex (fixedStrings: true for literal text). glob limits files ("*.md", "*.{ts,tsx}"). Hidden files, .gitignored files, binary files and symlinks are skipped; so are locations that are not connected and ~/Library (unless path is inside it). Returns matches with path, lineNumber, content (and contextBefore / contextAfter with contextLines), up to maxResults (default 100, max 500).',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['pattern', 'path'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: `File or folder to search. ${PATH_DOC}` },
        glob: { type: 'string', description: 'Only files matching this glob' },
        caseSensitive: { type: 'boolean', description: 'Default true' },
        fixedStrings: { type: 'boolean', description: 'Treat pattern as literal text' },
        contextLines: { type: 'integer', minimum: 0, maximum: 20 },
        maxResults: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    validate: (args) => (typeof args.pattern === 'string' && args.pattern.length > 0 ? (str(args, 'path') ? null : 'path is required') : 'pattern is required'),
    async run(args, ctx) {
      const rg = await findRipgrep()
      if (!rg) return fail('unsupported', 'ripgrep (rg) is not installed on this computer, so fs.grep cannot run. Use fs.find with query (Spotlight full-text search) instead, or ask the person to install ripgrep (brew install ripgrep).')
      const granted = ctx.granted()
      const raw = str(args, 'path')
      const where = await existingPath(raw, granted)
      if (!where.ok) return bad(where.message)
      const scope = await scopeOf(granted)
      let targets = [where.path]
      // 从个人文件夹搜:没连上的根、~/Library 与点开头的都不交给 rg(显式给的路径 rg 一定会进去)。
      if (lower(where.path) === lower(scope.home)) {
        targets = (await fsp.readdir(where.path))
          .filter((n) => !n.startsWith('.'))
          .map((n) => path.join(where.path, n))
          .filter((p) => scope.descend(p, where.path))
      }
      if (targets.length === 0) return ok({ total: 0, matches: [], truncated: false })
      const maxResults = clampInt(num(args, 'maxResults'), 100, 1, 500)
      const context = clampInt(num(args, 'contextLines'), 0, 0, 20)
      const cli = ['--json', '--no-config', '--max-columns', '500', '--max-columns-preview', '--max-filesize', '20M', '-m', String(maxResults)]
      if (bool(args, 'caseSensitive') === false) cli.push('-i')
      if (bool(args, 'fixedStrings') === true) cli.push('-F')
      if (context > 0) cli.push('-C', String(context))
      if (str(args, 'glob')) cli.push('-g', str(args, 'glob'))
      cli.push('--', args.pattern as string, ...targets)
      ctx.note('正在搜文件内容…')
      const r = await ctx.deps.exec(rg, cli, { signal: ctx.signal, timeoutMs: 60_000, maxBuffer: 32 * 1024 * 1024 })
      if (r.code === 1) return ok({ total: 0, matches: [], truncated: false })
      if (r.code !== 0 && !r.stdout.trim()) {
        const message = (r.stderr || `rg exited ${r.code}`).trim().slice(0, 500)
        return /regex parse error|error parsing glob/i.test(message) ? bad(message) : fail('execution_failed', message)
      }
      type Match = { path: string; lineNumber: number; content: string; contextBefore?: string[]; contextAfter?: string[] }
      const matches: Match[] = []
      let current: Match | null = null
      // rg 把每一行只发一次:上下文行先记着,既可能是上一处的「后」,也可能是下一处的「前」(与 grep -C 一样两边都给)。
      let pending: Array<{ line: number; text: string }> = []
      let full = false
      const cut = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s)
      for (const line of r.stdout.split('\n')) {
        if (!line) continue
        let msg: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const lineNumber = msg.data?.line_number ?? 0
        const text = cut((msg.data?.lines?.text ?? '').replace(/\r?\n$/, ''))
        if (msg.type === 'match') {
          if (matches.length >= maxResults) {
            full = true
            break
          }
          current = {
            path: msg.data?.path?.text ?? '(path is not UTF-8)',
            lineNumber,
            content: text,
            ...(context > 0 ? { contextBefore: pending.filter((p) => p.line >= lineNumber - context).map((p) => p.text), contextAfter: [] } : {}),
          }
          matches.push(current)
          pending = []
        } else if (msg.type === 'context' && context > 0) {
          if (current && lineNumber - current.lineNumber <= context) current.contextAfter!.push(text)
          pending.push({ line: lineNumber, text })
        } else if (msg.type === 'begin') {
          current = null
          pending = []
        }
      }
      return ok({
        total: matches.length,
        matches,
        truncated: full || matches.length >= maxResults,
        ...(r.code === 2 ? { warnings: r.stderr.trim().slice(0, 500) } : {}),
      })
    },
  })

  const ocr = fileAction({
    name: 'fs.ocr',
    title: '识别图中文字',
    titleEn: 'Recognize text (OCR)',
    description: 'Read the text in an image or scanned PDF with macOS\'s on-device Vision OCR (nothing is uploaded). Images: JPEG, PNG, HEIC, TIFF, GIF, WebP, BMP; PDFs: one page (page, default 1; pageCount comes back). languages in priority order, default ["zh-Hans", "en-US"] (short codes like "en", "ja", "ko", "zh-Hant" work). Returns text (lines joined by newlines, up to 64 KB), average confidence 0–1, and lines with their boxes as fractions of the image (x, y from the top-left, width, height).',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        languages: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        page: { type: 'integer', minimum: 1, description: 'PDF page (default 1)' },
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      if (args.languages !== undefined && (!Array.isArray(args.languages) || args.languages.length > 20 || args.languages.some((l) => typeof l !== 'string' || !l.trim()))) {
        return 'languages must be a list of language codes such as "zh-Hans", "en-US"'
      }
      return null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      if ((await fsp.stat(where.path)).isDirectory()) return bad(`${raw} is a folder`)
      ctx.note('正在识别文字…')
      const r = await ctx.deps.macHelper().call<{ text: string; lines: unknown[] } & Record<string, unknown>>('vision.ocr', {
        path: where.path,
        ...(Array.isArray(args.languages) && args.languages.length > 0 ? { languages: (args.languages as string[]).map((l) => l.trim()) } : {}),
        ...(num(args, 'page') !== undefined ? { page: clampInt(num(args, 'page'), 1, 1, 100_000) } : {}),
      }, { signal: ctx.signal, timeoutMs: 120_000 })
      const textCut = r.text.length > 65_536
      const linesCut = r.lines.length > 1000
      return ok({
        path: where.path,
        ...r,
        text: textCut ? r.text.slice(0, 65_536) : r.text,
        lines: linesCut ? r.lines.slice(0, 1000) : r.lines,
        ...(textCut || linesCut ? { truncated: true } : {}),
      })
    },
  })

  const tags = fileAction({
    name: 'fs.tags',
    title: 'Finder 标签',
    titleEn: 'Finder tags',
    description: 'Read or change the Finder tags of a file or folder. action get (default), set (replace all; an empty list removes all), add (keeps existing, skips names already there), remove (by name). tags are names or {name, color}; color is one of none, gray, green, purple, blue, yellow, red, orange. Returns the tags now on the file.',
    risk: 'medium',
    confirm: 'never',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        action: { type: 'string', enum: ['get', 'set', 'add', 'remove'] },
        tags: {
          type: 'array',
          maxItems: 100,
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string', enum: [...TAG_COLORS] } }, additionalProperties: false },
            ],
          },
        },
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      const action = str(args, 'action') || 'get'
      if (!['get', 'set', 'add', 'remove'].includes(action)) return 'action must be get, set, add or remove'
      if (action === 'get') return null
      if (args.tags === undefined && action !== 'set') return `tags is required for ${action}`
      if (args.tags !== undefined && tagsArg(args.tags) === null) return `tags must be names or {name, color} with color one of ${TAG_COLORS.join(', ')}`
      return null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const current = (await readTags(ctx, [where.path])).get(where.path)
      if (!current || !Array.isArray(current)) return fail('execution_failed', `cannot read the tags of ${raw}: ${current && !Array.isArray(current) ? current.error : 'no answer'}`)
      const action = str(args, 'action') || 'get'
      if (action === 'get') return ok({ path: where.path, tags: current })
      const given = tagsArg(args.tags ?? []) ?? []
      const names = new Set(given.map((t) => t.name))
      const next = action === 'set' ? given
        : action === 'add' ? [...current, ...given.filter((t) => !current.some((c) => c.name === t.name))]
        : current.filter((t) => !names.has(t.name))
      const now = await writeTags(ctx, where.path, next)
      await reindex(ctx, await onlyFiles([where.path]))
      return ok({ path: where.path, tags: now })
    },
  })

  /** 连上了的位置里带某个标签(或任何标签)的文件。 */
  const taggedFiles = async (ctx: ActionRunContext, scope: Scope, name?: string) => {
    const all = (await spotlight(ctx, scope.searchDirs(), name ? `kMDItemUserTags == "${mdq(name)}"cd` : 'kMDItemUserTags == "*"')).filter(scope.allowed)
    return { files: all.slice(0, 5000), truncated: all.length > 5000 }
  }

  const registry = fileAction({
    name: 'fs.tags_registry',
    title: '管理标签',
    titleEn: 'Manage tags',
    description: 'Finder tags across the connected locations (found with Spotlight). action list: every tag in use with its color and file count. rename (oldName, newName) / delete (name): change that tag on every file in the connected locations that has it — returns needs_confirmation with the file count first; call again with confirmed: true once the person agrees. favorites: the tags pinned in Finder\'s sidebar (read-only).',
    risk: 'medium',
    confirm: 'on_conflict',
    input_schema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'rename', 'delete', 'favorites'] },
        oldName: { type: 'string', description: 'rename: current tag name' },
        newName: { type: 'string', description: 'rename: new tag name' },
        name: { type: 'string', description: 'delete: tag to remove from all files' },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate(args) {
      const action = str(args, 'action')
      if (!['list', 'rename', 'delete', 'favorites'].includes(action)) return 'action must be list, rename, delete or favorites'
      if (action === 'rename' && (!str(args, 'oldName') || !str(args, 'newName'))) return 'rename needs oldName and newName'
      if (action === 'rename' && str(args, 'oldName') === str(args, 'newName')) return 'oldName and newName are the same'
      if (action === 'delete' && !str(args, 'name')) return 'delete needs name'
      return null
    },
    async run(args, ctx) {
      const action = str(args, 'action')
      if (action === 'favorites') {
        const exported = await ctx.deps.exec('/usr/bin/defaults', ['export', 'com.apple.finder', '-'], { signal: ctx.signal, timeoutMs: 15_000 })
        if (exported.code !== 0) return fail('execution_failed', `cannot read Finder settings: ${exported.stderr.trim().slice(0, 300)}`)
        const r = await ctx.deps.exec('/usr/bin/plutil', ['-extract', 'FavoriteTagNames', 'json', '-o', '-', '-'], { signal: ctx.signal, timeoutMs: 15_000, input: exported.stdout })
        // 没有这一项 = Finder 侧栏没设过标签。
        const parsed: unknown = r.code === 0 ? JSON.parse(r.stdout) : []
        const favorites = Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string' && n.length > 0) : []
        return ok({ favorites })
      }
      const scope = await scopeOf(ctx.granted())
      if (action === 'list') {
        const { files, truncated } = await taggedFiles(ctx, scope)
        const found = new Map<string, { color: string; fileCount: number }>()
        for (const value of (await readTags(ctx, files)).values()) {
          if (!Array.isArray(value)) continue
          for (const t of value) {
            const seen = found.get(t.name)
            if (!seen) found.set(t.name, { color: t.color, fileCount: 1 })
            else {
              seen.fileCount++
              if (seen.color === 'none') seen.color = t.color
            }
          }
        }
        const list = [...found.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name))
        return ok({ tags: list, filesScanned: files.length, ...(truncated ? { truncated: true, note: 'only the first 5000 tagged files were read' } : {}) })
      }
      const from = action === 'rename' ? str(args, 'oldName') : str(args, 'name')
      const { files } = await taggedFiles(ctx, scope, from)
      const current = await readTags(ctx, files)
      // Spotlight 按不分大小写找;真改的只有标签名一字不差的那些。
      const hits = files.filter((f) => {
        const t = current.get(f)
        return Array.isArray(t) && t.some((x) => x.name === from)
      })
      if (hits.length === 0) return ok({ filesModified: 0, note: `no file in the connected locations has the tag "${from}"` })
      if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
        const what = action === 'rename' ? `把 ${hits.length} 个文件上的标签「${from}」改成「${str(args, 'newName')}」` : `去掉 ${hits.length} 个文件上的标签「${from}」`
        return askFirst(
          `${hits.length} file(s) carry the tag "${from}". Ask the person, then call again with confirmed: true.`,
          `要${what}吗？`,
          { files: hits.slice(0, 20), total: hits.length },
        )
      }
      const to = str(args, 'newName')
      const changed: string[] = []
      const errors: string[] = []
      for (const f of hits) {
        const before = current.get(f) as Tag[]
        const next = action === 'rename'
          ? before.some((t) => t.name === to) ? before.filter((t) => t.name !== from) : before.map((t) => (t.name === from ? { ...t, name: to } : t))
          : before.filter((t) => t.name !== from)
        try {
          await writeTags(ctx, f, next)
          changed.push(f)
        } catch (error) {
          if (error instanceof NativeCallError && error.code === 'unsupported') throw error
          errors.push(`${f}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await reindex(ctx, await onlyFiles(changed))
      return ok({ ...(action === 'rename' ? { oldName: from, newName: to } : { name: from }), filesModified: changed.length, ...(errors.length > 0 ? { errors } : {}) })
    },
  })

  const volumes = fileAction({
    name: 'fs.volumes.list',
    title: '列出磁盘',
    titleEn: 'List volumes',
    description: 'List the disks / volumes mounted on this computer (the ones Finder shows): name, mount point, file system (apfs, hfs, exfat, smbfs…), total / used / free bytes, device, and whether it is the startup disk, internal, local, ejectable, removable, read-only or encrypted. mountPoint picks one (e.g. "/").',
    risk: 'low',
    confirm: 'never',
    input_schema: { type: 'object', properties: { mountPoint: { type: 'string' } }, additionalProperties: false },
    async run(args, ctx) {
      const r = await ctx.deps.macHelper().call<{ volumes: Array<{ mountPoint: string } & Record<string, unknown>> }>('files.volumes', {}, { signal: ctx.signal, timeoutMs: 30_000 })
      const wanted = str(args, 'mountPoint')
      const list = wanted ? r.volumes.filter((v) => v.mountPoint === wanted) : r.volumes
      if (wanted && list.length === 0) return bad(`no volume is mounted at ${wanted}; mounted: ${r.volumes.map((v) => v.mountPoint).join(', ')}`)
      return ok({ total: list.length, volumes: list })
    },
  })

  const xattr = fileAction({
    name: 'fs.xattr',
    title: '扩展属性',
    titleEn: 'Extended attributes',
    description: 'Read or change macOS extended attributes of a file. action list (names), get (value: text, or hex when binary), set (name + value as text), delete. Changing security attributes (com.apple.quarantine, com.apple.provenance, com.apple.macl) returns needs_confirmation first. For Finder tags use fs.tags; for download sources use fs.stat with spotlight: true.',
    risk: 'medium',
    confirm: 'on_conflict',
    input_schema: {
      type: 'object',
      required: ['path', 'action'],
      properties: {
        path: { type: 'string', description: PATH_DOC },
        action: { type: 'string', enum: ['list', 'get', 'set', 'delete'] },
        name: { type: 'string', description: 'Attribute name (get / set / delete)' },
        value: { type: 'string', description: 'Text value (set)' },
        ...CONFIRMED,
      },
      additionalProperties: false,
    },
    validate(args) {
      if (!str(args, 'path')) return 'path is required'
      const action = str(args, 'action')
      if (!['list', 'get', 'set', 'delete'].includes(action)) return 'action must be list, get, set or delete'
      if (action === 'list') return null
      const name = str(args, 'name')
      if (!name) return `name is required for ${action}`
      if (name.startsWith('-') || name.includes('\0')) return 'name is not a valid attribute name'
      if (action === 'set' && typeof args.value !== 'string') return 'value (text) is required for set'
      return null
    },
    async run(args, ctx) {
      const raw = str(args, 'path')
      const where = await existingPath(raw, ctx.granted())
      if (!where.ok) return bad(where.message)
      const action = str(args, 'action')
      const name = str(args, 'name')
      const xattrCli = (cli: string[]) => ctx.deps.exec('/usr/bin/xattr', cli, { signal: ctx.signal, timeoutMs: 15_000 })
      const failed = (r: { stderr: string; stdout: string; code: number }) => {
        const message = (r.stderr || r.stdout).trim()
        return /No such xattr/i.test(message) ? bad(`${raw} has no attribute ${name}`) : fail('execution_failed', message.slice(0, 300) || `xattr exited ${r.code}`)
      }
      if (action === 'list') {
        const r = await xattrCli([where.path])
        if (r.code !== 0) return failed(r)
        return ok({ path: where.path, attributes: r.stdout.split('\n').filter(Boolean) })
      }
      if (action === 'get') {
        const r = await xattrCli(['-px', name, where.path])
        if (r.code !== 0) return failed(r)
        const bytes = Buffer.from(r.stdout.replace(/\s+/g, ''), 'hex')
        let text: string | null = null
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          text = null
        }
        if (text !== null && !hasControlChars(text)) {
          return ok({ path: where.path, name, value: text.length > 65_536 ? text.slice(0, 65_536) : text, size: bytes.length, ...(text.length > 65_536 ? { truncated: true } : {}) })
        }
        const hex = bytes.toString('hex')
        return ok({
          path: where.path,
          name,
          hex: hex.length > 65_536 ? hex.slice(0, 65_536) : hex,
          size: bytes.length,
          binary: true,
          ...(hex.length > 65_536 ? { truncated: true } : {}),
          ...(bytes.subarray(0, 8).toString('latin1') === 'bplist00' ? { note: 'binary property list' } : {}),
        })
      }
      const security = SECURITY_XATTRS[name] ?? (name.startsWith('com.apple.cs.') ? '代码签名相关的信息' : undefined)
      if (security && args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
        return askFirst(
          `${name} is a security attribute. Ask the person, then call again with confirmed: true.`,
          `要${action === 'set' ? '改写' : '删掉'}「${where.path}」的 ${name}（${security}）吗？`,
          { path: where.path, name, action },
        )
      }
      const r = await xattrCli(action === 'set' ? ['-w', name, args.value as string, where.path] : ['-d', name, where.path])
      if (r.code !== 0) return failed(r)
      return ok({ path: where.path, name, ...(action === 'set' ? { value: args.value } : { deleted: true }) })
    },
  })

  return {
    groups: [rootGroup('files.desktop'), rootGroup('files.documents'), rootGroup('files.downloads'), rootGroup('files.other')],
    actions: [list, read, write, patch, mkdir, move, copy, trash, stat, find, grep, ocr, tags, registry, volumes, xattr],
  }
}
