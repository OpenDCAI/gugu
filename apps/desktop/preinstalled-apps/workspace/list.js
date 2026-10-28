// What the folder's list is made of, without the page: which kind a file is, the label and colour of its mark, its size
// in words, the time sections of a list sorted by time, and the orders the person picks. app.js draws with these.

/** The kinds the list's segments pick (全部 / 文档 / 图片和视频 / 其他); a folder is none of them. */
export const KINDS = ['all', 'docs', 'media', 'other']

const DOC_TYPES = /^(text\/|application\/(pdf|json|rtf|msword|vnd\.openxmlformats-officedocument\.|vnd\.ms-(excel|powerpoint)|vnd\.oasis\.opendocument\.))/i
const DOC_SUFFIXES = new Set(['.pdf', '.md', '.txt', '.json', '.csv', '.tsv', '.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.key', '.pages', '.numbers', '.html', '.htm', '.xml', '.yaml', '.yml', '.log'])

/** 文档: what is read as text or as a document; 图片和视频: what is looked at; the rest 其他. */
export function kindOf(entry) {
  if (entry.type === 'folder') return null
  const type = entry.contentType || ''
  if (/^(image|video)\//i.test(type)) return 'media'
  if (entry.type === 'text' || entry.type === 'json' || DOC_TYPES.test(type) || DOC_SUFFIXES.has(suffixOf(entry))) return 'docs'
  return 'other'
}

/** The suffix a file goes by, `.pdf`: the one the host worked out (`entry.suffix`), else its name's. */
function suffixOf(entry) {
  const suffix = entry.suffix || (/\.[^./]{1,8}$/.exec(entry.name || '') ?? [''])[0]
  return suffix.toLowerCase()
}

// Families a mark is coloured by: the suffix says it, then the content type (a file named without one).
const FAMILIES = [
  ['pdf', /^\.pdf$/, /pdf/],
  ['word', /^\.(docx?|odt|rtf|pages)$/, /msword|wordprocessing|opendocument\.text/],
  ['sheet', /^\.(xlsx?|csv|tsv|ods|numbers)$/, /excel|spreadsheet|csv/],
  ['slides', /^\.(pptx?|odp|key)$/, /powerpoint|presentation/],
  ['archive', /^\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/, /zip|compressed|x-tar|gzip/],
  ['image', /^\.(png|jpe?g|gif|webp|bmp|svg|heic|avif|ico)$/, /^image\//],
  ['video', /^\.(mp4|mov|webm|mkv|avi|m4v)$/, /^video\//],
  ['audio', /^\.(mp3|wav|m4a|aac|flac|ogg|opus)$/, /^audio\//],
  ['code', /^\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|sh|rb|php|swift|kt|sql)$/, /javascript|typescript|x-python|x-sh/],
  ['text', /^\.(md|txt|json|ya?ml|xml|html?|log)$/, /^text\/|json/],
]

/** A file's mark (Telegram's, QQ's): its suffix on a square coloured by its family — `{ label: 'PDF', family: 'pdf' }`. */
export function markOf(entry) {
  // A claim's long suffix (`.vote.json`) is marked by its last part, what the file is.
  const suffix = suffixOf(entry).replace(/^.*(?=\.[^.]+$)/, '')
  const type = (entry.contentType || '').toLowerCase()
  const family = FAMILIES.find(([, bySuffix, byType]) => (suffix ? bySuffix.test(suffix) : false) || (!suffix && byType.test(type)))?.[0]
    ?? FAMILIES.find(([, , byType]) => byType.test(type))?.[0]
    ?? 'other'
  const label = suffix ? suffix.slice(1, 5).toUpperCase() : (family === 'other' ? '' : family.slice(0, 4).toUpperCase())
  return { label, family }
}

/** Bytes in words: 820 B, 19.6 KB, 2.4 GB. */
export function sizeOf(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * The section a time falls in, newest first: today, yesterday, the past 7 days, then each month — `{ key, kind, month? }`.
 * `now` is passed in so a list drawn once reads one clock.
 */
export function sectionOf(iso, now) {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return { key: 'earlier', kind: 'earlier' }
  const days = Math.round((day(now) - day(new Date(at))) / 86400000)
  if (days <= 0) return { key: 'today', kind: 'today' }
  if (days === 1) return { key: 'yesterday', kind: 'yesterday' }
  if (days < 7) return { key: 'week', kind: 'week' }
  const date = new Date(at)
  return { key: `${date.getFullYear()}-${date.getMonth() + 1}`, kind: 'month', year: date.getFullYear(), month: date.getMonth() + 1 }
}

/** The orders the person picks: the newest change first (with sections), by name, the largest first. */
export const SORTS = ['recent', 'name', 'size']

export function comparer(sort, nameOf, changedAt, locale) {
  if (sort === 'name') return (a, b) => nameOf(a).localeCompare(nameOf(b), locale || undefined, { numeric: true })
  if (sort === 'size') return (a, b) => (b.size ?? -1) - (a.size ?? -1) || nameOf(a).localeCompare(nameOf(b), locale || undefined)
  return (a, b) => (Date.parse(changedAt(b)) || 0) - (Date.parse(changedAt(a)) || 0)
}

/**
 * The time left on a cloud copy kept for a while (`entry.keep.expiresAt`), in the largest unit, rounded up as 「还剩 N 天」
 * is said (a copy just made temporary for 7 days has 7 left): `{ days }`, `{ hours }`, or `{ minutes }` (at least 1);
 * null when it is kept, has no copy, or the time is past.
 */
export function timeLeft(expiresAt, now) {
  const at = Date.parse(expiresAt ?? '')
  if (!Number.isFinite(at)) return null
  const minutes = Math.floor((at - now.getTime()) / 60000)
  if (minutes < 0) return null
  if (minutes >= 24 * 60) return { days: Math.ceil(minutes / (24 * 60)) }
  if (minutes >= 60) return { hours: Math.ceil(minutes / 60) }
  return { minutes: Math.max(1, minutes) }
}

/** Where a file is kept, as the 「存放」 filter picks it: `cloud`, or the machine a project file stays on (its name). */
export function whereOf(entry, machineName) {
  return entry.storedOn ? machineName(entry.storedOn) : 'cloud'
}

/**
 * How long a file's cloud copy is kept, as the 「保留方式」 filter picks it: `temporary`, `kept`, or null (no cloud copy).
 * `soon` is a temporary one cleared within 7 days.
 */
export function keptAs(entry, now) {
  if (!entry.keep) return null
  if (!entry.keep.expiresAt) return 'kept'
  return Date.parse(entry.keep.expiresAt) - now.getTime() <= 7 * 86400000 ? 'soon' : 'temporary'
}

/**
 * Whether a file is one the filters pick (`{ who, where, keep }`, each null for any): who made it (a person's id), where
 * it is kept, how long — `temporary` takes the ones going within 7 days too.
 */
export function matches(entry, filters, machineName, now) {
  if (filters.who && entry.createdBy?.id !== filters.who) return false
  if (filters.where && whereOf(entry, machineName) !== filters.where) return false
  if (filters.keep) {
    const kept = keptAs(entry, now)
    if (filters.keep === 'temporary' ? kept !== 'temporary' && kept !== 'soon' : kept !== filters.keep) return false
  }
  return true
}

/** The view a kind opens in, until the person picks another: images and videos as a grid, the rest as a list. */
export const defaultView = (kind) => (kind === 'media' ? 'grid' : 'list')

/**
 * A thumbnail is drawn for an image with a cloud copy, of a size worth reading whole. A project file kept on its machine
 * is read for one only while it has a cloud copy too (`keep`, a project chat's temporary one): reading it otherwise would
 * upload it.
 */
export const THUMB_MAX_BYTES = 10 * 1024 * 1024
export function wantsThumb(entry) {
  return entry.type !== 'folder' && /^image\//i.test(entry.contentType || '') && (!entry.storedOn || !!entry.keep)
    && (entry.size == null || entry.size <= THUMB_MAX_BYTES) && !/svg/i.test(entry.contentType)
}
