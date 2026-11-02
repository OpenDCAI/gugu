import { reaction } from 'mobx'
import { ATTACHMENT_UPLOAD_PROTOCOL, TASK_ATTACHMENT_PROTOCOL, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FOLDER_FILES, type TurnFileRef } from '@gugu/session-core/session-record/contract'
import { resumeTaskAttachment, type AttachmentUploadContext } from './taskAttachmentUpload'
import { isSshMachine, sshMachinesReady } from './sshLinkChannel'
import { machineCodec } from '@/session/renderer/lib/machine-routing'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { readCachedDevices } from '@/store/devicesCache'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { findRemoteHostsBridge } from '@/session/shared/remote-hosts'
import { transfersFor } from '@/session/renderer/features/remote-hosts/workspace/remote-transfer-wiring'
import type { UploadItem } from '@/session/renderer/features/remote-hosts/workspace/remote-transfers'
import { entryUploadItems, type DropEntry } from '@/session/renderer/features/remote-hosts/workspace/remote-drop-items'

export type TaskAttachmentTarget = {
  chatId: string; owner: string; sessionId?: string; deviceId?: string | null
  projectId?: string; workspaceId?: string
}

export const taskAttachmentWorkspacePath = (id: string, name: string) => `.gugu/attachments/${id}/${name}`

/** Only this computer's explicit SSH mapping can carry attachment bytes. A tunnel is a different route. */
export function taskAttachmentUsesSsh(deviceId: string): boolean {
  return findRemoteHostsBridge()?.listDevices().find(device => device.id === deviceId)?.connectVia === 'ssh'
}

export function assertTaskAttachmentProtocol(protocol: number | undefined): void {
  if ((protocol ?? 0) < TASK_ATTACHMENT_PROTOCOL) throw Object.assign(new Error('Update the task host to send attachments'), { code: 'host_update_required' })
}

export async function pushTaskDirectory(to: TaskAttachmentTarget, entry: FileSystemDirectoryEntry): Promise<string> {
  const items = await entryUploadItems(entry as unknown as DropEntry)
  if (items.length > MAX_ATTACHMENT_FOLDER_FILES || items.reduce((size, item) => size + item.size, 0) > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(new Error('A folder can contain at most 10,000 files and 50 MiB in total'), { code: 'folder_too_large' })
  }
  const relative = await pushTaskFiles(to, crypto.randomUUID(), items)
  if (!items.length) {
    const directory = await rpcOn(to.deviceId).workspace.files.getAbsolutePath(to.projectId!, to.workspaceId!, relative)
    if (!directory.success) throw new Error('The uploaded folder is not available')
    const created = await rpcOn(to.deviceId).workspace.files.createEntry(to.projectId!, to.workspaceId!, directory.data.path, entry.name, 'folder')
    if (!created.success) throw new Error('Could not create the empty folder')
  }
  const result = await rpcOn(to.deviceId).workspace.files.getAbsolutePath(to.projectId!, to.workspaceId!, `${relative}/${entry.name}`)
  if (!result.success) throw new Error('The uploaded folder is not available')
  return result.data.path
}

export async function pushTaskFiles(to: TaskAttachmentTarget, id: string, items: UploadItem[], onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (!to.deviceId || !taskAttachmentUsesSsh(to.deviceId)) throw new Error('This computer has no SSH connection to the task host')
  assertTaskAttachmentProtocol(readCachedDevices().find(row => row.device_id === to.deviceId)?.capabilities?.remote_protocol)
  if (!to.projectId || !to.workspaceId) throw new Error('The task workspace is not available')
  const files = rpcOn(to.deviceId).workspace.files
  const root = await files.getAbsolutePath(to.projectId, to.workspaceId, '.')
  signal?.throwIfAborted()
  if (!root.success) throw new Error('The task workspace is not available')
  let directory = root.data.path
  for (const name of ['.gugu', 'attachments']) {
    const created = await files.createEntry(to.projectId, to.workspaceId, directory, name, 'folder')
    signal?.throwIfAborted()
    if (!created.success && created.error.type !== 'exists') throw new Error('Could not create the task attachment directory')
    directory = `${directory.replace(/\/$/, '')}/${name}`
  }
  if (!items.length) {
    const created = await files.createEntry(to.projectId, to.workspaceId, directory, id, 'folder')
    if (!created.success) throw new Error('Could not create the task attachment directory')
    return `.gugu/attachments/${id}`
  }
  const transfers = transfersFor(to.deviceId, to.projectId, to.workspaceId)
  const active = () => transfers.items.find(item => item.name === id && item.status === 'running')
  const cancel = () => active()?.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  const stop = reaction(() => active()?.done ?? -1, sent => {
    if (signal?.aborted) cancel()
    else if (sent >= 0) onProgress?.(sent, items.reduce((size, item) => size + item.size, 0))
  })
  let result
  try { result = await transfers.upload(directory, items.map(item => ({ ...item, segments: [id, ...item.segments] })), id) }
  finally { stop(); signal?.removeEventListener('abort', cancel) }
  signal?.throwIfAborted()
  if (!result || result.status !== 'done' || result.skipped.length) throw result?.error ?? new Error('SSH attachment upload failed')
  return `.gugu/attachments/${id}`
}

/** Only references cross the host RPC. Offline hosts resolve them at delivery instead. */
// Cancellation drops the chip and caller's wait; an already-started host prefetch may finish in this task's directory.
export async function prefetchTaskFiles(to: TaskAttachmentTarget, files: TurnFileRef[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!to.sessionId) return
  const input = { conversationId: to.sessionId, files }
  const device = to.deviceId ? readCachedDevices().find(row => row.device_id === to.deviceId) : null
  if (device?.is_online === false) return
  if (device?.capabilities?.remote_protocol !== undefined) assertTaskAttachmentProtocol(device.capabilities.remote_protocol)
  const timeoutMs = 60_000 + Math.ceil(files.reduce((total, file) => total + file.sizeBytes, 0) / (64 * 1024)) * 1000
  let results: Array<{ itemId: string; ok: boolean; error?: string; code?: string }>
  if (to.deviceId && device?.capabilities?.host_kind === 'phone') {
    const { invokePhoneHost } = await import('@/mobile/local-agent/phoneHostRpc')
    results = await invokePhoneHost(to.deviceId, 'sessionTimeline.prefetchFiles', [input], undefined, timeoutMs, signal)
  } else if (to.deviceId) {
    const { callDeviceRpc } = await import('./deviceRpc')
    const reply = await callDeviceRpc<{ value: typeof results; protocol?: number }>(to.deviceId, 'taskhost.call',
      { channel: 'sessionTimeline.prefetchFiles', args: [machineCodec(to.deviceId).outbound(input)], protocol: REMOTE_PROTOCOL_VERSION }, { timeoutMs, signal })
    if (reply.error) throw new Error(reply.error.message)
    assertTaskAttachmentProtocol(reply.result?.protocol)
    results = reply.result!.value
  } else {
    let abort = () => {}
    try {
      results = await Promise.race([rpcOn(null).sessionTimeline.prefetchFiles(input), new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason ?? new Error('aborted'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })])
    } finally { signal?.removeEventListener('abort', abort) }
  }
  signal?.throwIfAborted()
  if (!Array.isArray(results)) throw Object.assign(new Error('Update the task host to send attachments'), { code: 'host_update_required' })
  const failed = results.filter(result => !result.ok)
  if (failed.length) throw Object.assign(new Error(failed.map(result => result.error).join('\n')), { code: failed[0]?.code })
}

/** A task file has a durable receiver; directory/file-tree saves retain their own contract. */
export async function pushTaskAttachment(to: TaskAttachmentTarget, file: TurnFileRef, source: Blob, context: AttachmentUploadContext,
  onProgress?: (sent: number, total: number) => void, signal?: AbortSignal, onPhase?: (phase: 'uploading' | 'resuming' | 'confirming') => void): Promise<string> {
  signal?.throwIfAborted()
  await sshMachinesReady()
  signal?.throwIfAborted()
  if (!to.deviceId || !isSshMachine(to.deviceId)) throw new Error('This computer has no SSH connection to the task host')
  if (!to.deviceId || !taskAttachmentUsesSsh(to.deviceId) || !to.projectId || !to.workspaceId) throw new Error('The SSH task workspace is not available')
  const protocol = readCachedDevices().find(row => row.device_id === to.deviceId)?.capabilities?.remote_protocol ?? 0
  if (protocol < ATTACHMENT_UPLOAD_PROTOCOL) throw Object.assign(new Error('Update the task host to resume attachments'), { code: 'host_update_required' })
  const api = rpcOn(to.deviceId).workspace.files
  const unwrap = <T,>(result: { success: true; data: T } | { success: false; error: { type: string; message?: string } }): T => {
    if (!result.success) throw Object.assign(new Error(result.error.message ?? result.error.type), { code: result.error.type })
    return result.data
  }
  return resumeTaskAttachment({ source, itemId: file.itemId, name: file.name,
    scope: `${to.deviceId}/${to.projectId}/${to.workspaceId}`, context, signal, onProgress, onPhase,
    transport: {
      begin: async spec => unwrap(await api.attachmentUploadBegin(to.projectId!, to.workspaceId!, spec)),
      status: async spec => unwrap(await api.attachmentUploadStatus(to.projectId!, to.workspaceId!, spec)),
      write: async chunk => unwrap(await api.attachmentUploadWrite(to.projectId!, to.workspaceId!, chunk)),
      commit: async spec => unwrap(await api.attachmentUploadCommit(to.projectId!, to.workspaceId!, spec)),
      abort: async spec => unwrap(await api.attachmentUploadAbort(to.projectId!, to.workspaceId!, spec)),
    },
  })
}
