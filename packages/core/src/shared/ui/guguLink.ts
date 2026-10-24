export { guguLinkScheme } from './linkScheme.mjs'

export type LinkPlace = { chat: string } | { session: string }

/**
 * A place in a file, as the App that picked it names it: its own keys and values (`{ slide: '3', shape: '12' }`,
 * `{ range: 'R&D!A1' }`). App 引用 pill (155 10-15): gugu writes it into the link and reads it back — the App never
 * spells the link, nor escapes anything in it.
 */
export type FilePlace = Record<string, string>

/** A file of a group's workspace, and where in it: `version` is the version the place was picked on. */
export interface GroupFileLink {
  itemId: string
  version?: number
  at?: FilePlace
}

export type FileLinkClassification =
  | { kind: 'workspace-file'; path: string; at?: FilePlace }
  | ({ kind: 'group-file' } & GroupFileLink)
  | { kind: 'external' }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// The file, then anything after `?` and `#`: a link is read for what it names and the rest is let be (155 10-15 — a
// parser anchored on the whole link read every later addition as no link at all; dev to 0.2.54 did).
const GROUP_FILE_LINK = new RegExp(`^gugu-file://(${UUID})/?(?:\\?([^#]*))?(?:#(.*))?$`, 'is')

/**
 * `gugu-file://<itemId>[?v=<version>][#<place>]` — a file of a group's (or a topic's) workspace, as the MCP tools and
 * `gugu.send` write it (摩擦单 F10). Its id is unique, and which chat it is in is read from it when it opens (F112 — a chat
 * id in the link was one more thing an agent had to copy, and got wrong). `?v=` and `#` are what an App reference adds:
 * the version it was picked on, and the place in the file (`k=v&k=v`). A query parameter it does not know is let be, as
 * a `v` that is not a whole number is. The one reading of it: a chat link, `session_open_in_tab`, a pill, anywhere else.
 */
export function parseGroupFileLink(href: string): GroupFileLink | null {
  const match = GROUP_FILE_LINK.exec(href.trim())
  if (!match) return null
  const version = /(?:^|&)v=(\d+)(?:&|$)/.exec(match[2] ?? '')?.[1]
  const at = match[3] === undefined ? null : placeOf(match[3])
  return {
    itemId: match[1]!.toLowerCase(),
    ...(version === undefined ? {} : { version: Number(version) }),
    ...(at && Object.keys(at).length > 0 ? { at } : {}),
  }
}

/**
 * The place out of a link's `#…`: `k=v&k=v`, each key and value decoded once — what `groupFileLink` escaped; a chat
 * bubble's href arrives percent-encoded by the renderer (its Chinese too), a transcript's as written: both read the same.
 */
function placeOf(fragment: string): FilePlace {
  // No prototype: a key the App named `__proto__` comes back its own, as the App named it (复核 48fb0bde).
  const place: FilePlace = Object.create(null) as FilePlace
  for (const pair of fragment.split('&')) {
    if (!pair) continue
    const cut = pair.indexOf('=')
    const key = decoded(cut < 0 ? pair : pair.slice(0, cut))
    if (key) place[key] = cut < 0 ? '' : decoded(pair.slice(cut + 1))
  }
  return place
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    // Written by hand with a bare '%': as it stands, rather than lost.
    return part
  }
}

// What may not stand bare in a key or a value: the place's own `&`, `=`; `%` (it would decode); `;` (after an `&` it
// would read as an entity, `&lt;`); `#`; `+` (a form decoder — URLSearchParams — reads it as a space); and what breaks a
// markdown link or a pill around it — whitespace, control characters, brackets, a double quote, a backtick, a bar. `:`,
// `!`, `'`, `,` and any language's letters stay as written, so an agent reads `#slide=3&shape=12` / `#range=销售!B2:D4` /
// `#range=R%26D!A1` near as it is.
// eslint-disable-next-line no-control-regex -- control characters are exactly what may not stand in a link
const NOT_BARE = /[&=%;#+\s<>\\()[\]{}"`|\u0000-\u001f\u007f]/g
/** As `%XX`: encodeURIComponent leaves `(` and `)` as they are, and a bare one ends a markdown link. */
const escaped = (c: string) => (c === '(' || c === ')' ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(c))
const part = (text: string) => text.replace(NOT_BARE, escaped)

/**
 * The one way gugu writes such a link — the place's keys and values escaped one by one, in the App's order, so whatever
 * the App named comes back to it as it was (`parseGroupFileLink`).
 */
export function groupFileLink(
  itemId: string,
  place: { version?: number | null; at?: Readonly<Record<string, string | number>> | null } = {},
): string {
  const version = place.version == null ? '' : `?v=${place.version}`
  const pairs = Object.entries(place.at ?? {}).map(([key, value]) => `${part(key)}=${part(String(value))}`)
  return `gugu-file://${itemId}${version}${pairs.length ? `#${pairs.join('&')}` : ''}`
}

const EXPLICIT_URL_SCHEME = /^[a-z][a-z\d+.-]*:/i

// 一个 ASCII 字母 + 冒号 + 路径分隔符是 Windows 盘符(`C:\…`/`C:/…`),不是 URL scheme ——
// 现实里的 scheme 都 ≥2 个字母。不先放行它,EXPLICIT_URL_SCHEME 会把 `C:` 当 scheme 吞掉,
// 于是 Windows 上最常见的绝对路径形态被分类成 external,默认导航又被 Electron 拦下,链接静默死掉。
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

// `/C:/x/a.svg` —— 盘符路径的 **URL 拼法**(`file:///C:/…` 去掉 scheme 后剩下的那截)。agent 写
// Windows 路径时常这么写,因为 CommonMark 的 `<…>` 目的地里它比反斜杠省事。前导斜杠不是路径的
// 一部分:带着它去问文件系统,Windows 上没有任何一层能把它解释回 `C:\…`,于是链接点了没反应
// (#5902 实测:点一次只发出 statExternalFile,面板什么都不开、也不报错)。
// ⇒ 在这里还原成盘符路径 —— 这是 href 变成「一条本机路径」的**唯一**出口,下游全都按盘符路径工作。
const URL_STYLE_DRIVE_PATH = /^\/[a-z]:[\\/]/i

// A working-copy link's `#…` is a place when it reads as one — `k=v&k=v` (what an App's reference writes, as a group
// file's link carries it) or a line, `L10` / `L10-L20` — and only then: a name with a `#` of its own (`issue#12.md`,
// `C#笔记.md`, a folder `a#k=v/`) stays the name. A name whose last `#…` does read as a place is linked with that `#` as `%23`.
const PLACE_FRAGMENT = /^[^&=#/\\]+=[^&#/\\]*(?:&[^&=#/\\]+=[^&#/\\]*)*$/
const LINE_FRAGMENT = /^L\d+(?:-L?\d+)?$/

function workspacePlace(href: string): { path: string; at?: FilePlace } {
  const cut = href.lastIndexOf('#')
  const fragment = href.slice(cut + 1)
  if (cut < 0 || !(PLACE_FRAGMENT.test(fragment) || LINE_FRAGMENT.test(fragment))) return { path: href }
  return { path: href.slice(0, cut), at: placeOf(fragment) }
}

/** Classify rendered hrefs before an external-link fallback handles them. */
export function classifyFileLink(href: string): FileLinkClassification {
  const candidate = href.trim()
  if (!candidate || candidate.startsWith('#')) {
    return { kind: 'external' }
  }
  const groupFile = parseGroupFileLink(candidate)
  if (groupFile) return { kind: 'group-file', ...groupFile }

  const { path: raw, at } = workspacePlace(href)
  const placed = at && Object.keys(at).length > 0 ? { at } : {}
  let path = raw
  try {
    // decodeURI keeps `%23` as it is: the one escape a name's own `#` needs, read back here.
    path = decodeURI(raw).replace(/%23/gi, '#')
  } catch {
    // A literal '%' is valid in a filesystem name; preserve malformed URI text as a path.
  }
  // 用解码后的 path 判盘符:产出端把反斜杠百分号编码成 `C:%5CUsers%5C…` 时,raw 形态里
  // 分隔符还不是 `\`/`/`,拿 raw 去判会把单字母 scheme 正则又放进来吞掉它。
  if (URL_STYLE_DRIVE_PATH.test(path)) {
    return { kind: 'workspace-file', path: path.slice(1), ...placed }
  }
  if (WINDOWS_DRIVE_PATH.test(path)) {
    return { kind: 'workspace-file', path, ...placed }
  }
  if (EXPLICIT_URL_SCHEME.test(candidate)) {
    return { kind: 'external' }
  }
  return { kind: 'workspace-file', path, ...placed }
}

/** A conversation, optionally one message in it. The reader still checks access when opening it. */
export type ConversationLink = { chatId: string; messageId?: string }

const LINK = new RegExp(`^gugu-chat://(${UUID})(?:/(${UUID}))?/?$`, 'i')

/** A stable Markdown destination, shared by agent tools, chat and session transcripts. */
export function conversationLink(chatId: string, messageId?: string): string {
  const href = `gugu-chat://${chatId}${messageId ? `/${messageId}` : ''}`
  if (!parseConversationLink(href)) throw new Error('A conversation link requires a chat UUID and, optionally, a message UUID')
  return href
}

export function parseConversationLink(href: string): ConversationLink | null {
  const match = LINK.exec(href.trim())
  return match ? { chatId: match[1]!.toLowerCase(), ...(match[2] ? { messageId: match[2].toLowerCase() } : {}) } : null
}

/** Beyond this a link stops being a link and starts being a payload. */
const MAX_EXTENSION_LINK_LENGTH = 2048;

export interface ParsedExtensionLink {
  extensionId: string;
  tab: string;
  path: string;
  query: Record<string, string>;
  /** Where it opens: a session, a chat — or null, the App's own page. */
  place: LinkPlace | null;
}

const PLACE_KEYS = { chat: 'gugu.chat', session: 'gugu.session' } as const;

function buildAppLink(input: ParsedExtensionLink, scheme: string): string {
  const tab = input.tab;
  const segments = input.path.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('path must not contain "." or ".." segments');
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('gugu.')) throw new Error(`query keys starting with "gugu." are gugu's own: ${key}`);
    if (typeof value === 'object') throw new Error(`query value for "${key}" must be a string, number or boolean`);
    search.append(key, String(value));
  }
  if (input.place) {
    const [kind, id] = 'chat' in input.place ? (['chat', input.place.chat] as const) : (['session', input.place.session] as const);
    search.append(PLACE_KEYS[kind], id);
  }
  const tail = segments.map(encodeURIComponent).join('/');
  const query = search.toString();
  const link = `${scheme}://ext/${input.extensionId}/${tab}${tail ? `/${tail}` : ''}${query ? `?${query}` : ''}`;
  if (link.length > MAX_EXTENSION_LINK_LENGTH) {
    throw new Error(`link is longer than ${MAX_EXTENSION_LINK_LENGTH} characters — keep data in the App, put an id in the link`);
  }
  return link;
}

/** Stored chat/file links are independent of the build that writes or reads the message. */
export type GuguLinkTarget =
  | ({ kind: 'chat' } & ConversationLink)
  | ({ kind: 'file' } & GroupFileLink)
  | ({ kind: 'app' } & ParsedExtensionLink)
  | { kind: 'session'; sessionId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'server-login'; code: string }

/** One reader for stored references and OS links. Only external invocation binds a link to a build's scheme. */
export function parseGuguLink(raw: string, options: { supabaseUrl?: string } = {}): GuguLinkTarget | null {
  const chat = parseConversationLink(raw)
  if (chat) return { kind: 'chat', ...chat }
  const file = parseGroupFileLink(raw)
  if (file) return { kind: 'file', ...file }
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (options.supabaseUrl) {
    try {
      const base = new URL(options.supabaseUrl)
      if (url.origin === base.origin && url.pathname.replace(/\/+$/, '') === `${base.pathname.replace(/\/+$/, '')}/functions/v1/server-login`) {
        return { kind: 'server-login', code: url.searchParams.get('code')?.trim() ?? '' }
      }
    } catch { /* An invalid database URL cannot name a login approval. */ }
  }
  const scheme = url.protocol.slice(0, -1)
  if (!/^gugu(?:-[a-z0-9-]+)?$/.test(scheme)) return null
  if (url.hostname === 'ext') {
    if (raw.length > MAX_EXTENSION_LINK_LENGTH) return null
    const [extensionId, tab, ...rest] = url.pathname.split('/').filter(Boolean)
    if (!extensionId || !tab) return null
    let path: string
    try { path = rest.map(decodeURIComponent).join('/') } catch { return null }
    const chat = url.searchParams.get(PLACE_KEYS.chat)
    const session = url.searchParams.get(PLACE_KEYS.session)
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) if (!key.startsWith('gugu.')) query[key] = value
    return { kind: 'app', extensionId, tab, path, query, place: session ? { session } : chat ? { chat } : null }
  }
  if (url.hostname === 'chat') {
    const match = new RegExp(`^/(${UUID})(?:/message/(${UUID}))?/?$`, 'i').exec(url.pathname)
    return match ? { kind: 'chat', chatId: match[1]!.toLowerCase(), ...(match[2] ? { messageId: match[2].toLowerCase() } : {}) } : null
  }
  if (url.hostname === 'file') {
    const target = parseGroupFileLink(`gugu-file://${url.pathname.slice(1)}${url.search}${url.hash}`)
    return target ? { kind: 'file', ...target } : null
  }
  const id = url.pathname.slice(1)
  if (!id || id.includes('/') || url.search || url.hash) return null
  try {
    if (url.hostname === 'session') return { kind: 'session', sessionId: decodeURIComponent(id) }
    if (url.hostname === 'project') return { kind: 'project', projectId: decodeURIComponent(id) }
  } catch { return null }
  return null
}

/** A stored reference by default; `scheme` asks for a link that invokes that installed build from outside. */
export function guguLink(target: Exclude<GuguLinkTarget, { kind: 'server-login' }>, scheme?: string): string {
  switch (target.kind) {
    case 'chat': {
      const stored = conversationLink(target.chatId, target.messageId)
      return scheme ? `${scheme}://chat/${target.chatId}${target.messageId ? `/message/${target.messageId}` : ''}` : stored
    }
    case 'file': {
      const stored = groupFileLink(target.itemId, target)
      return scheme ? `${scheme}://file/${stored.slice('gugu-file://'.length)}` : stored
    }
    case 'app':
      if (!scheme) throw new Error('An App link needs the build scheme')
      return buildAppLink(target, scheme)
    case 'session':
    case 'project':
      if (!scheme) throw new Error('An external resource link needs the build scheme')
      return `${scheme}://${target.kind}/${encodeURIComponent(target.kind === 'session' ? target.sessionId : target.projectId)}`
  }
}

/** App linkTo arguments; the only default is the caller's own first declared tab. No lookup or permission to open. */
export function linkTargetOf(args: Record<string, unknown>, own: { id: string; contributes: { tabs: readonly { name: string }[] } }): Exclude<GuguLinkTarget, { kind: 'server-login' }> {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value) throw new Error(`${field} must name its target`)
    return value
  }
  switch (args.kind ?? 'app') {
    case 'chat': return { kind: 'chat', chatId: text(args.chat, 'chat'), ...(args.message ? { messageId: text(args.message, 'message') } : {}) }
    case 'file': {
      const file = typeof args.file === 'object' && args.file ? (args.file as { id?: unknown }).id : args.file
      if (args.version !== undefined && (!Number.isInteger(args.version) || Number(args.version) < 1)) throw new Error('version must be a positive whole number')
      const at = args.at == null ? undefined : Object.fromEntries(Object.entries(args.at as object).map(([key, value]) => {
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error('A file place has string or number values')
        return [key, String(value)]
      }))
      return { kind: 'file', itemId: text(file, 'file'), ...(args.version === undefined ? {} : { version: Number(args.version) }), ...(at ? { at } : {}) }
    }
    case 'session': return { kind: 'session', sessionId: text(args.session, 'session') }
    case 'project': return { kind: 'project', projectId: text(args.project, 'project') }
    case 'app': {
      const extensionId = args.app === undefined ? own.id : text(args.app, 'app')
      const tab = args.tab ?? (extensionId === own.id ? own.contributes.tabs[0]?.name : undefined)
      if (extensionId === own.id && !own.contributes.tabs.some((entry) => entry.name === tab)) throw new Error(`this App has no tab named: ${String(tab)}`)
      if (args.chat != null && args.session != null) throw new Error('An App link opens in one place')
      return {
        kind: 'app', extensionId, tab: text(tab, 'tab'), path: typeof args.path === 'string' ? args.path : '',
        query: (args.query ?? {}) as Record<string, string>,
        place: args.chat != null ? { chat: text(args.chat, 'chat') } : args.session != null ? { session: text(args.session, 'session') } : null,
      }
    }
    default: throw new Error(`Unknown link target: ${String(args.kind)}`)
  }
}

