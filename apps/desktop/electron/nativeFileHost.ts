import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { createFileSink } from './fileSnapshot'
import type { SelectedProjectFile, ProjectFileMessage } from './projectFilePublication'
import { sanitizeRemoteFileName } from './remoteFileOpen'
import { fileRefKey, requireFileRange, requireFileRevision, type FileBytes, type FileContext, type FileProviders, type FileRevision, type FileStageCommand } from '@gugu/core/shared/fileResolver'

/** Opaque capabilities stay within the issuing renderer and account. Bytes use the existing invoke bus and FileSink. */
export function createNativeFileHost(deps: {
  root: string; owner(): Promise<string | null>; alive(scope: number): boolean
  local: FileProviders['local']; ssh: FileProviders['ssh']; openPath(path: string): Promise<string>
  published(directory: string): void; maxBytes?: number
  publish?(chatId: string, file: SelectedProjectFile, owner: string, message?: ProjectFileMessage, task?: { itemId?: string }): Promise<unknown>
  /** A task attachment's own copy for the agent (`writeTaskCopy`): its path. */
  taskCopy?(name: string, bytes: Uint8Array, mimeType?: string): Promise<{ path: string; name: string; size: number; mimeType?: string }>
  publication?(chatId: string, owner: string): Promise<boolean>
}) {
  type Entry = { scope: number; epoch: number; owner: string; file?: FileBytes; context?: string; name?: string; size?: number; sha?: string;
    sink?: Awaited<ReturnType<typeof createFileSink>>; hash?: ReturnType<typeof createHash>; written?: number; path?: string; busy?: boolean }
  const entries = new Map<string, Entry>()
  let lastOwner: string | null = null
  const epochs = new Map<number, number>()
  const epochOf = (scope: number) => { const value = epochs.get(scope) ?? 0; epochs.set(scope, value); return value }
  const check = async (scope: number, owner: string, epoch: number) => {
    if (!deps.alive(scope) || epoch !== epochOf(scope) || owner !== await deps.owner()) throw new Error('File reader account or window changed')
  }
  const drop = async (scope?: number) => {
    for (const id of scope === undefined ? epochs.keys() : [scope]) epochs.set(id, epochOf(id) + 1)
    await Promise.all([...entries].filter(([, entry]) => scope === undefined || entry.scope === scope).map(async ([id, entry]) => {
      entries.delete(id); await entry.file?.dispose(); await entry.sink?.abort()
    }))
  }
  const entryFor = async (scope: number, id: string) => {
    const entry = entries.get(id)
    if (!entry || entry.scope !== scope) throw new Error('File handle is unavailable')
    await check(scope, entry.owner, entry.epoch); return entry
  }
  return { drop,
    /** `task`: a task's input attachment, kept on this device (`ProjectFilePublishOptions.task`). */
    async publish(scope: number, request: { chatId: string; file?: SelectedProjectFile; message?: ProjectFileMessage; task?: boolean; itemId?: string }) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || !deps.publish || !request.file && !deps.publication) throw new Error('File publisher is unavailable')
      await check(scope, owner, epoch); const row = request.file ? await deps.publish(request.chatId, request.file, owner, request.message, request.task === true ? { itemId: request.itemId } : undefined) : await deps.publication!(request.chatId, owner); await check(scope, owner, epoch); return row
    },
    async taskCopy(scope: number, request: { name: string; data: ArrayBuffer; mimeType?: string }) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || !deps.taskCopy) throw new Error('File publisher is unavailable')
      await check(scope, owner, epoch); return deps.taskCopy(request.name, new Uint8Array(request.data), request.mimeType)
    },
    async ownerChanged(owner: string | null) { if (owner !== lastOwner) { lastOwner = owner; await drop() } },
    async read(scope: number, context: FileContext, request: { op: string; id?: string; revision?: FileRevision; offset?: number; length?: number }) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || context.actor.accountId !== owner) throw new Error('File reader is not signed in')
      const key = JSON.stringify([context.actor.accountId, context.actor.actorId, fileRefKey(context.ref)])
      if (request.op === 'local' || request.op === 'open' || request.op === 'ssh') {
        const local = request.op === 'ssh' ? null : await deps.local(context)
        await check(scope, owner, epoch)
        if (request.op === 'local') return local?.revision ?? null
        const revision = request.revision!; requireFileRevision(revision)
        if (local && JSON.stringify([local.revision.item_id, local.revision.version, local.revision.sha256, local.revision.size_bytes]) !==
          JSON.stringify([revision.item_id, revision.version, revision.sha256, revision.size_bytes])) throw new Error('Local file revision changed')
        const file = request.op === 'ssh' ? await deps.ssh(revision, context) : await local?.open()
        if (!file) return null
        try { await check(scope, owner, epoch) } catch (error) { await file.dispose(); throw error }
        const id = randomUUID(); entries.set(id, { scope, epoch, owner, context: key, file }); return { id, size: file.size }
      }
      const entry = await entryFor(scope, request.id!)
      if (!entry.file || entry.context !== key) throw new Error('File handle belongs to another reader')
      if (request.op === 'dispose') { entries.delete(request.id!); await entry.file.dispose(); return }
      if (request.op !== 'read') throw new Error('Unknown file operation')
      requireFileRange(entry.file.size, request.offset!, request.length!)
      const bytes = await entry.file.read(request.offset!, request.length!); await check(scope, owner, entry.epoch); return bytes
    },
    async stage(scope: number, command: FileStageCommand) {
      if (command.op === 'begin') {
        const { revision } = command, epoch = epochOf(scope), owner = await deps.owner()
        if (!owner) throw new Error('File reader is not signed in')
        requireFileRange(revision.size_bytes, 0, 0)
        if (revision.size_bytes > (deps.maxBytes ?? Infinity)) throw new Error('File exceeds the byte limit')
        if (typeof revision.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(revision.sha256)) throw new Error('Invalid file commitment')
        const name = sanitizeRemoteFileName(command.name), sink = await createFileSink(deps.root, revision.size_bytes)
        try { await check(scope, owner, epoch) } catch (error) { await sink.abort(); throw error }
        const id = randomUUID(); entries.set(id, { scope, epoch, owner, name, sink, sha: revision.sha256, size: revision.size_bytes, written: 0, hash: createHash('sha256') }); return { id }
      }
      const entry = await entryFor(scope, command.id)
      if (entry.busy) throw new Error('File stage is busy')
      entry.busy = true
      try {
        if (command.op === 'abort') return
        if (!entry.sink) throw new Error('File stage is unavailable')
        if (command.op === 'chunk') {
          if (!(command.bytes instanceof Uint8Array)) throw new Error('Invalid file bytes')
          requireFileRange(entry.size!, entry.written!, command.bytes.length)
          await entry.sink.write(command.bytes); entry.hash!.update(command.bytes); entry.written! += command.bytes.length; return
        }
        if (command.op !== 'commit') throw new Error('Unknown file stage operation')
        if (entry.written !== entry.size || entry.hash!.digest('hex') !== entry.sha) throw new Error('File SHA-256 mismatch')
        await entry.sink.commit(); await check(scope, entry.owner, entry.epoch)
        const directory = join(deps.root, `open-${entry.sha}`), path = join(directory, entry.name!)
        const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        const hash = createHash('sha256')
        if (existing?.size === entry.size) for await (const bytes of createReadStream(path)) hash.update(bytes)
        if (existing?.size !== entry.size || hash.digest('hex') !== entry.sha) {
          if (existing) await chmod(path, 0o600)
          await mkdir(directory, { recursive: true, mode: 0o700 }); await rename(entry.sink.path(), path)
        }
        await entry.sink.abort(); entry.sink = undefined; entry.path = path; deps.published(directory)
      } catch (error) { entries.delete(command.id); await entry.sink?.abort(); throw error }
      finally { entry.busy = false; if (command.op === 'abort') { entries.delete(command.id); await entry.sink?.abort() } }
    },
    async open(scope: number, id: string) {
      const entry = await entryFor(scope, id)
      if (!entry.path || entry.sink) throw new Error('File stage is not committed')
      try { const error = await deps.openPath(entry.path); if (error) throw new Error(`Could not open file: ${error}`) }
      finally { entries.delete(id) } // Keep the verified cache file for repeated opens, including an OS refusal.
    },
  }
}

/** Bind lifetime to the existing WebContents; no additional connection or service is created. */
export function registerNativeFileIpc(ipc: IpcMain, host: ReturnType<typeof createNativeFileHost>, warn: (error: unknown) => void) {
  const bound = new Set<number>()
  const scope = (event: IpcMainInvokeEvent) => {
    const id = event.sender.id
    if (!bound.has(id)) {
      bound.add(id)
      const close = () => { bound.delete(id); event.sender.removeListener('destroyed', close); event.sender.removeListener('render-process-gone', close); void host.drop(id).catch(warn) }
      event.sender.once('destroyed', close); event.sender.once('render-process-gone', close)
    }
    return id
  }
  ipc.handle('files:task-copy', async (event, row: Parameters<typeof host.taskCopy>[1]) => {
    try { return await host.taskCopy(scope(event), row) } catch (error) { warn(error); throw error }
  })
  ipc.handle('files:publish', async (event, row: Parameters<typeof host.publish>[1]) => {
    try { return await host.publish(scope(event), row) } catch (error) { warn(error); throw error }
  })
  ipc.handle('files:read', (event, row: FileContext & Parameters<typeof host.read>[2]) => host.read(scope(event), { actor: row.actor, ref: row.ref }, row))
  ipc.handle('files:stage', (event, row: FileStageCommand) => host.stage(scope(event), row))
  ipc.handle('files:stage-open', (event, row: { id: string }) => host.open(scope(event), row.id))
}
