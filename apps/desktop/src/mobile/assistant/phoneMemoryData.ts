// #7199 手机「记忆」那一格读写它家里的文件:动词全是 assistant-machine-core 那一组(与桌面同一份核心),
// 这里只把桌面页面里那几步(删一条记忆连同索引、数一数、资料夹里往下钻、上传)拆成不带界面的函数,手机页与单测共用。
import { VOICE_NOTES_DIR } from '@gugu/core/shared/voiceNotes'
import type { DirectoryEntry } from '@shared/core/fs/fs'
import { joinPath, removeIndexEntry, resourceRejection, type ResourceRejection } from '@/session/renderer/features/assistant/assistant-files'
import {
  AssistantFileError,
  listDirectory,
  makeFolder,
  readText,
  removePath,
  uploadFile,
  writeText,
  type AssistantMachine,
  type MemoryEntry,
} from '@/session/renderer/features/assistant/assistant-machine-core'

/** 删一条记忆:文件 + MEMORY.md 里指向它的那一行(与桌面 MemoryNoteDetail 同一套;索引是它每次开工读的目录)。 */
export async function deleteMemoryNote(machine: AssistantMachine, entry: Pick<MemoryEntry, 'path' | 'file'>, onRemoved?: () => Promise<void>): Promise<void> {
  await removePath(machine, entry.path)
  await onRemoved?.()
  if (machine.panel) return
  const index = await readText(machine, machine.paths.memoryIndex)
  if (index === null) return
  const next = removeIndexEntry(index, entry.file)
  if (next !== index) await writeText(machine, machine.paths.memoryIndex, next)
}

export function voiceNotesDirOf(machine: AssistantMachine): string {
  return joinPath(machine.paths.memoryDir, VOICE_NOTES_DIR)
}

const visible = (entry: DirectoryEntry) => !entry.name.startsWith('.')

/** 记忆首页两张小卡下面那个数:语音笔记几条、资料夹里几样。数不出来 = null(那张卡不写数,❌ 写 0)。 */
export async function readMemoryCounts(machine: AssistantMachine): Promise<{ voice: number | null; files: number | null }> {
  const count = (dir: string, keep: (entry: DirectoryEntry) => boolean) =>
    listDirectory(machine, dir).then(
      (entries) => entries.filter(keep).length,
      () => null,
    )
  const [voice, files] = await Promise.all([
    count(voiceNotesDirOf(machine), (entry) => entry.type === 'directory' && visible(entry)),
    count(machine.paths.resourcesDir, visible),
  ])
  return { voice, files }
}

// ── 资料夹(「给助理的资料」):路由 `files` / `files:<相对路径>`,与桌面同一套名字 ─────────────────────

export function filesTrail(sub: string): string[] {
  return sub.startsWith('files:') ? sub.slice('files:'.length).split('/').filter(Boolean) : []
}

export function filesSub(trail: readonly string[]): string {
  return trail.length ? `files:${trail.join('/')}` : 'files'
}

export function resourcePathOf(machine: AssistantMachine, trail: readonly string[]): string {
  return trail.reduce((dir, name) => joinPath(dir, name), machine.paths.resourcesDir)
}

/** Use the same location for reading, uploading and asking the assistant to inspect files. */
export function resourceDisplayPath(machine: AssistantMachine, trail: readonly string[]): string {
  const path = resourcePathOf(machine, trail)
  const home = machine.home.replace(/\/+$/, '')
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** 手机上看一个文件最多读这么大(与核心 readText 同一个上限);大了不读,只说多大。 */
export const VIEW_MAX_BYTES = 1_048_576

export type FileContentView = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'too-large'; size: number }

export type ResourceView =
  | { kind: 'folder'; entries: DirectoryEntry[] }
  | { kind: 'file'; entry: DirectoryEntry; content: FileContentView }
  /** 路由指着的那一项已经不在了(被删、改名)。 */
  | { kind: 'gone' }

/** 看一个文件:不是文本 / 太大如实说,❌ 当成空文件。 */
export async function readFileForView(machine: AssistantMachine, path: string): Promise<FileContentView> {
  if (machine.panel) {
    const data = await machine.panel.bytes(path)
    if (!data) throw new AssistantFileError('missing','The file no longer exists')
    if (data.length > VIEW_MAX_BYTES) return { kind: 'too-large',size: data.length }
    try {
      const text = new TextDecoder('utf-8',{ fatal: true }).decode(data)
      return text.includes('\0') ? { kind: 'binary' } : { kind: 'text',text }
    } catch { return { kind: 'binary' } }
  }
  if (!machine.rpc) throw new AssistantFileError('unavailable','File access is unavailable')
  const result = await machine.rpc.workspace.files.readExternalFile(machine.projectId, machine.workspaceId, path, VIEW_MAX_BYTES)
  if (!result.success) throw new AssistantFileError(result.error.type, 'message' in result.error ? String(result.error.message) : result.error.type)
  if (result.data.truncated) return { kind: 'too-large', size: result.data.totalSize }
  if (result.data.binary) return { kind: 'binary' }
  return { kind: 'text', text: result.data.content }
}

/**
 * 资料夹里往下钻到的那一格:路由只带路径,是文件还是文件夹问上一层(与列它自己并行,文件夹不多等一来回)。
 * 根(资料夹本身)还没建 = 空(第一次上传时才建)。
 */
export async function readResourceView(machine: AssistantMachine, trail: readonly string[]): Promise<ResourceView> {
  const path = resourcePathOf(machine, trail)
  if (trail.length === 0) return { kind: 'folder', entries: await listDirectory(machine, path) }
  const [parent, self] = await Promise.all([
    listDirectory(machine, resourcePathOf(machine, trail.slice(0, -1))),
    listDirectory(machine, path).then(
      (entries) => ({ entries }),
      (error: unknown) => ({ error }),
    ),
  ])
  const entry = parent.find((candidate) => candidate.name === trail[trail.length - 1])
  if (!entry) return { kind: 'gone' }
  if (entry.type === 'directory') {
    if ('error' in self) throw self.error
    return { kind: 'folder', entries: self.entries }
  }
  return { kind: 'file', entry, content: await readFileForView(machine, entry.path) }
}

export function visibleEntries(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return entries.filter(visible)
}

export type UploadOutcome = {
  done: string[]
  rejected: Array<{ name: string; reason: ResourceRejection }>
  failed: Array<{ name: string; message: string }>
}

/**
 * 从手机传几个文件进资料夹的某一层(桌面 ResourceFiles 同一套规矩:50MB 以内、不收音视频和压缩包;
 * 资料夹第一次用之前没有,传到根上时先建)。一个没传上不拦后面的,各自记下来如实说。
 */
export async function uploadResources(
  machine: AssistantMachine,
  trail: readonly string[],
  files: readonly File[],
  onFile?: (name: string) => void,
): Promise<UploadOutcome> {
  const outcome: UploadOutcome = { done: [], rejected: [], failed: [] }
  const accepted: File[] = []
  for (const file of files) {
    const reason = resourceRejection(file)
    if (reason) outcome.rejected.push({ name: file.name, reason })
    else accepted.push(file)
  }
  if (!accepted.length) return outcome
  if (trail.length === 0) {
    const root = machine.paths.resourcesDir
    const split = root.lastIndexOf('/')
    await makeFolder(machine, root.slice(0, split) || '/', root.slice(split + 1))
  }
  const dir = resourcePathOf(machine, trail)
  for (const file of accepted) {
    onFile?.(file.name)
    try {
      await uploadFile(machine, dir, file)
      outcome.done.push(file.name)
    } catch (error) {
      outcome.failed.push({ name: file.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcome
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
