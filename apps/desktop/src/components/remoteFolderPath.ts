// 远端目录选择器(RemoteFolderPicker)的纯路径逻辑:不碰 React、不碰网络,单测直接喂字符串。
// 路径是**那台机器上**的路径(POSIX 为主,兼容 Windows 盘符),❌ 不能用本机的 node:path 去算。
import type { DeviceFsEntry } from '@gugu/core/cloud/deviceFsProtocol'

export type PathSegment = { label: string; path: string }

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

export function pathSegments(absolutePath: string): PathSegment[] {
  if (!absolutePath) return []
  const isHome = absolutePath.startsWith('~')
  const trimmed = absolutePath.replace(/\/+$/, '')
  if (isHome) {
    const rest = trimmed.slice(1).replace(/^\/+/, '')
    const parts = rest ? rest.split('/').filter(Boolean) : []
    const segs: PathSegment[] = [{ label: '~', path: '~' }]
    let acc = '~'
    for (const part of parts) {
      acc = acc + '/' + part
      segs.push({ label: part, path: acc })
    }
    return segs
  }
  const parts = trimmed.split('/').filter(Boolean)
  const segs: PathSegment[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc = acc + '/' + part
    segs.push({ label: part, path: acc })
  }
  return segs
}

export function parentOf(absolutePath: string): string {
  if (!absolutePath || absolutePath === '/' || absolutePath === '~') return absolutePath
  const trimmed = absolutePath.replace(/\/+$/, '')
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) return trimmed
  if (WINDOWS_DRIVE.test(trimmed)) {
    const normalized = trimmed.replace(/\\+$/, '')
    const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
    if (idx <= 2) return normalized.slice(0, 2) + '\\'
    return normalized.slice(0, idx)
  }
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return trimmed.startsWith('/') ? '/' : '~'
  const parent = trimmed.slice(0, idx)
  return parent || '/'
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  if (WINDOWS_DRIVE.test(base)) return base.replace(/[\\/]+$/, '') + '\\' + name
  if (base === '/') return '/' + name
  return base.replace(/\/+$/, '') + '/' + name
}

/** 能点进去的(文件夹、链接)在前、文件在后,各自按名字排。 */
export function sortEntries(entries: DeviceFsEntry[]): DeviceFsEntry[] {
  const dirs: DeviceFsEntry[] = []
  const files: DeviceFsEntry[] = []
  for (const entry of entries) {
    if (isEnterable(entry)) dirs.push(entry)
    else files.push(entry)
  }
  const cmp = (a: DeviceFsEntry, b: DeviceFsEntry) => a.name.localeCompare(b.name)
  return [...dirs.sort(cmp), ...files.sort(cmp)]
}

/** 能点进去的:文件夹,以及指向不明的链接(点了由那台机器判它是不是文件夹)。 */
export function isEnterable(entry: DeviceFsEntry): boolean {
  return entry.kind === 'dir' || entry.kind === 'symlink'
}

/** 长目录里「筛选这个文件夹」:名字里包含查询串(不分大小写)。 */
export function filterEntries(entries: DeviceFsEntry[], query: string): DeviceFsEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(q))
}

/**
 * 地址栏正在输入的草稿 → 「在哪个目录里补全、补全什么前缀」。
 * `/srv/da` → 在 `/srv` 里找 `da` 开头的;`/srv/` → 列 `/srv` 下全部;`~/co` → 在 `~` 里找 `co`。
 * 没有目录部分(还没敲出 `/` 或 `~`)时不补全。
 */
export function splitCompletionDraft(draft: string): { dir: string; prefix: string } | null {
  const value = draft.trim()
  if (!value) return null
  if (value === '~') return { dir: '~', prefix: '' }
  // 咕咕 server 只装在 Linux / Mac 上(behavior gugu-server 第 1 条),补全只认 `/` 分隔。
  const slash = value.lastIndexOf('/')
  if (slash === -1) return null
  const dirPart = value.slice(0, slash)
  const dir = dirPart === '' ? '/' : dirPart
  if (!(dir.startsWith('/') || dir.startsWith('~'))) return null
  return { dir, prefix: value.slice(slash + 1) }
}

/** 补全候选:能点进去的项里,名字以前缀开头的(不分大小写),前缀完全相等的排最前。 */
export function completionCandidates(entries: DeviceFsEntry[], prefix: string, limit = 8): DeviceFsEntry[] {
  const p = prefix.toLowerCase()
  const showHidden = p.startsWith('.')
  return entries
    .filter((entry) => isEnterable(entry))
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    .filter((entry) => entry.name.toLowerCase().startsWith(p))
    .sort((a, b) => {
      const exactA = a.name.toLowerCase() === p ? 0 : 1
      const exactB = b.name.toLowerCase() === p ? 0 : 1
      return exactA - exactB || a.name.localeCompare(b.name)
    })
    .slice(0, limit)
}

/**
 * 选的是不是「整台机器」级别的大目录。选它当项目根,agent 能看到、改动的就是整台机器 / 整个主目录,
 * 通常是手滑(同类产品 Zed 在这里也提醒)。home 不知道(老版本的机器不报)时只认 `~` 本身。
 */
export function broadRootKind(path: string, home: string | null | undefined): 'root' | 'home' | null {
  const trimmed = path.trim()
  if (trimmed === '/' || /^[A-Za-z]:[\\/]*$/.test(trimmed)) return 'root'
  const normalized = trimmed.replace(/[\\/]+$/, '')
  if (normalized === '~') return 'home'
  if (home && normalized === home.replace(/[\\/]+$/, '')) return 'home'
  return null
}

/** 新文件夹名的本地校验(那台机器上还会再判一次):空的、`.`/`..`、带斜杠的都不行。 */
export function newFolderNameProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed)) return 'invalid'
  return null
}
