/**
 * #7199 文件位置的授权:四个固定的根 —— 桌面 / 文稿 / 下载 各是那一个文件夹;其他位置 = 个人文件夹里除这三处以外的地方。
 * 一个路径算不算「连上了」只看它的**真实位置**(符号链接按指向判,❌ 借链接跳出去);还不存在的路径(要新建 / 写入)按它最近一个
 * 已经存在的上级的真实位置判。凡是收路径参数的动作(读写文件、发附件……)都过这里。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const FILE_ROOTS = ['files.desktop', 'files.documents', 'files.downloads', 'files.other'] as const
export type FileRoot = (typeof FILE_ROOTS)[number]

const ROOT_TITLES: Record<FileRoot, string> = { 'files.desktop': '桌面', 'files.documents': '文稿', 'files.downloads': '下载', 'files.other': '其他位置' }

export function rootDir(root: Exclude<FileRoot, 'files.other'>, home: string): string {
  return path.join(home, root === 'files.desktop' ? 'Desktop' : root === 'files.documents' ? 'Documents' : 'Downloads')
}

export function grantedRootTitles(granted: ReadonlySet<string>): string[] {
  return FILE_ROOTS.filter((r) => granted.has(r)).map((r) => ROOT_TITLES[r])
}

export function expandHome(raw: string, home = os.homedir()): string {
  return raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
}

type Resolved = { ok: true; path: string } | { ok: false; message: string }

async function judge(real: string, raw: string, granted: ReadonlySet<string>): Promise<Resolved> {
  const home = os.homedir()
  const realHome = await fsp.realpath(home).catch(() => home)
  const inside = (dir: string) => real === dir || real.startsWith(dir + path.sep)
  const named = (['files.desktop', 'files.documents', 'files.downloads'] as const).map((r) => ({ r, dir: rootDir(r, realHome) }))
  const hit = named.find(({ dir }) => inside(dir))
  if (hit) {
    if (granted.has(hit.r)) return { ok: true, path: real }
  } else if (granted.has('files.other') && inside(realHome)) {
    return { ok: true, path: real }
  }
  return { ok: false, message: `${raw} is not inside a location connected on this computer (connected: ${grantedRootTitles(granted).join(', ') || 'none'})` }
}

/**
 * 先只看字面路径(❌ 碰磁盘):落在没连上的位置就当场拒。碰磁盘本身就会让 macOS 为「桌面 / 文稿 / 下载」弹授权框 ——
 * 不能为一个用户没连上的文件夹去弹。字面过了还要按真实位置再判一次(链接可能指到别处),两道都过才算。
 * APFS 默认不分大小写,比较时也不分。
 */
function lexicalInsideRoots(expanded: string, granted: ReadonlySet<string>): boolean {
  const home = os.homedir()
  const target = path.resolve(expanded).toLowerCase()
  const inside = (dir: string) => target === dir.toLowerCase() || target.startsWith(dir.toLowerCase() + path.sep)
  const named = (['files.desktop', 'files.documents', 'files.downloads'] as const).find((r) => inside(rootDir(r, home)))
  if (named) return granted.has(named)
  return granted.has('files.other') && inside(home)
}

function precheck(raw: string, granted: ReadonlySet<string>): { ok: true; expanded: string } | { ok: false; message: string } {
  if (!raw) return { ok: false, message: 'path is required' }
  const expanded = expandHome(raw)
  if (!path.isAbsolute(expanded)) return { ok: false, message: `path must be absolute (or start with ~/): ${raw}` }
  if (!FILE_ROOTS.some((r) => granted.has(r))) {
    return { ok: false, message: 'No file location is connected on this computer yet (Desktop / Documents / Downloads / Other locations)' }
  }
  if (!lexicalInsideRoots(expanded, granted)) {
    return { ok: false, message: `${raw} is not inside a location connected on this computer (connected: ${grantedRootTitles(granted).join(', ')})` }
  }
  return { ok: true, expanded }
}

/** 已经存在的路径。 */
export async function resolveInsideRoots(raw: string, granted: ReadonlySet<string>): Promise<Resolved> {
  const pre = precheck(raw, granted)
  if (!pre.ok) return pre
  let real: string
  try {
    real = await fsp.realpath(pre.expanded)
  } catch {
    return { ok: false, message: `not found: ${raw}` }
  }
  return judge(real, raw, granted)
}

/** 可能还不存在的路径(写入、新建、移到的目标):按最近一个存在的上级的真实位置判,再接上后面那段。 */
export async function resolveTargetInsideRoots(raw: string, granted: ReadonlySet<string>): Promise<Resolved> {
  const pre = precheck(raw, granted)
  if (!pre.ok) return pre
  let existing = path.resolve(pre.expanded)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await fsp.realpath(existing)
      // path.resolve 已经把 .. 化掉了,rest 里只有普通的名字。
      return judge(path.join(real, ...[...rest].reverse()), raw, granted)
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return { ok: false, message: `not found: ${raw}` }
      rest.push(path.basename(existing))
      existing = parent
    }
  }
}
