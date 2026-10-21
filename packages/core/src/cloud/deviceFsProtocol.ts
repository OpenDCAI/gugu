export type DeviceFsEntryKind = 'dir' | 'file' | 'symlink'

export type DeviceFsEntry = {
  name: string
  kind: DeviceFsEntryKind
}

export type DeviceFsListResult = {
  path: string
  entries: DeviceFsEntry[]
  /**
   * 那台机器上当前用户的主目录(绝对路径)。选择器拿它判「选的是不是主目录本身」、画「主目录」捷径。
   * 老版本的机器不报它 —— 缺席 = 不知道,❌ 不补默认值冒充事实。
   */
  home?: string
}

/** 在那台机器上新建一个文件夹(`fs.make-directory`)。`path` 是新文件夹的完整路径,父目录必须已存在。 */
export type DeviceFsMakeDirectoryPayload = {
  path: string
}

export type DeviceFsMakeDirectoryResult = {
  path: string
}

export type DeviceFsListPayload = {
  path: string
  show_hidden?: boolean
}

const VALID_KINDS: ReadonlySet<DeviceFsEntryKind> = new Set(['dir', 'file', 'symlink'])

function normalizeEntry(raw: unknown): DeviceFsEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name : ''
  const kind = typeof obj.kind === 'string' ? obj.kind : ''
  if (!name) return null
  if (!VALID_KINDS.has(kind as DeviceFsEntryKind)) return null
  return { name, kind: kind as DeviceFsEntryKind }
}

export function normalizeDeviceFsListResult(raw: unknown): DeviceFsListResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const path = typeof obj.path === 'string' ? obj.path : ''
  const entriesRaw = Array.isArray(obj.entries) ? obj.entries : []
  if (!path) return undefined
  const entries: DeviceFsEntry[] = []
  for (const item of entriesRaw) {
    const normalized = normalizeEntry(item)
    if (normalized) entries.push(normalized)
  }
  const home = typeof obj.home === 'string' && obj.home ? obj.home : undefined
  return home ? { path, entries, home } : { path, entries }
}

export function normalizeDeviceFsMakeDirectoryResult(raw: unknown): DeviceFsMakeDirectoryResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const path = (raw as Record<string, unknown>).path
  return typeof path === 'string' && path ? { path } : undefined
}
