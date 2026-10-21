import { homedir } from 'node:os'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { DeviceRpcResponse } from './deviceRpcProtocol'
import type {
  DeviceFsEntry,
  DeviceFsEntryKind,
  DeviceFsListPayload,
  DeviceFsListResult,
  DeviceFsMakeDirectoryPayload,
  DeviceFsMakeDirectoryResult,
} from './deviceFsProtocol'

const MAX_ENTRIES = 1000

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  return path
}

function errnoCode(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? ''
}

export async function listDeviceDirectory(
  payload: DeviceFsListPayload,
  options?: { homedir?: () => string },
): Promise<DeviceRpcResponse<DeviceFsListResult>> {
  const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
  if (!rawPath) {
    return { error: { code: 'invalid_path', message: 'path is required' } }
  }

  const home = (options?.homedir ?? homedir)()
  const expanded = expandHome(rawPath, home)
  const resolvedPath = isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded)

  try {
    const dirStat = await stat(resolvedPath)
    if (!dirStat.isDirectory()) {
      return { error: { code: 'not_a_directory', message: `not a directory: ${resolvedPath}` } }
    }

    const showHidden = payload.show_hidden === true
    const dirents = await readdir(resolvedPath, { withFileTypes: true })
    const entries: DeviceFsEntry[] = []
    let truncated = false
    for (const dirent of dirents) {
      if (!showHidden && dirent.name.startsWith('.')) continue
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      entries.push({ name: dirent.name, kind: direntKind(dirent) })
    }

    const result: DeviceFsListResult = { path: resolvedPath, entries, home }
    if (truncated) {
      return {
        result,
        error: { code: 'too_many_entries', message: `more than ${MAX_ENTRIES} entries; showing first ${MAX_ENTRIES}` },
      }
    }
    return { result }
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT') {
      return { error: { code: 'not_found', message: `not found: ${resolvedPath}` } }
    }
    if (code === 'ENOTDIR') {
      return { error: { code: 'not_a_directory', message: `not a directory: ${resolvedPath}` } }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { error: { code: 'permission_denied', message: `permission denied: ${resolvedPath}` } }
    }
    return { error: { code: 'internal_error', message: (error as Error)?.message ?? String(error) } }
  }
}

// @@@symlink-kind-precedence - the picker shows a distinct symlink glyph; a symlink to a dir must
// read as 'symlink', not 'dir'. isSymbolicLink() reflects the link itself, so check it first.
function direntKind(dirent: { isSymbolicLink: () => boolean; isDirectory: () => boolean }): DeviceFsEntryKind {
  if (dirent.isSymbolicLink()) return 'symlink'
  if (dirent.isDirectory()) return 'dir'
  return 'file'
}

/**
 * 在那台机器上新建一个文件夹(选项目时「新建文件夹」)。只建一层:父目录必须已存在,
 * 同名的已经在了就报 `already_exists`,❌ 不当成功(用户以为建了个新的空文件夹,其实是别人的)。
 */
export async function makeDeviceDirectory(
  payload: DeviceFsMakeDirectoryPayload,
  options?: { homedir?: () => string },
): Promise<DeviceRpcResponse<DeviceFsMakeDirectoryResult>> {
  const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
  if (!rawPath) return { error: { code: 'invalid_path', message: 'path is required' } }
  const home = (options?.homedir ?? homedir)()
  const expanded = expandHome(rawPath, home)
  const resolvedPath = isAbsolute(expanded) ? resolve(expanded) : resolve(home, expanded)
  const name = basename(resolvedPath)
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
    return { error: { code: 'invalid_path', message: `invalid folder name: ${resolvedPath}` } }
  }
  try {
    await mkdir(resolvedPath)
    return { result: { path: resolvedPath } }
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'EEXIST') return { error: { code: 'already_exists', message: `already exists: ${resolvedPath}` } }
    if (code === 'ENOENT') return { error: { code: 'not_found', message: `parent not found: ${resolvedPath}` } }
    if (code === 'ENOTDIR') return { error: { code: 'not_a_directory', message: `parent is not a directory: ${resolvedPath}` } }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { error: { code: 'permission_denied', message: `permission denied: ${resolvedPath}` } }
    }
    return { error: { code: 'internal_error', message: (error as Error)?.message ?? String(error) } }
  }
}
