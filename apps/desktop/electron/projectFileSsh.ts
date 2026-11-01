import { createDeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import type { FileContext, FileRevision } from '@gugu/core/shared/fileResolver'
import { attachSshDeviceRpcPipe, type SharedSshLinks } from './device-rpc-requester'
import { PROJECT_FILE_READ, openProjectFileSource, snapshotProjectFile, type ProjectFileChunk, type ProjectFileReader } from './projectFileHost'

export type HeldFileSshLinks = Pick<SharedSshLinks, 'tap' | 'send'> & {
  /** Real owner SSH mappings only; tunnels and connections from another account are excluded. */
  ownedOpen(deviceId: string, accountId: string): Promise<boolean>
}

export function ownSshFileProvider(links: HeldFileSshLinks, tempRoot: string) {
  return async (revision: FileRevision, context: FileContext) => {
    const deviceId = revision.host_device_id!, accountId = context.actor.accountId
    if (context.actor.actorId !== accountId || revision.host_account_id !== accountId || !await links.ownedOpen(deviceId, accountId)) return null
    const requester = createDeviceRpcRequester({ userId: async () => accountId, openPipe: async (device, handlers) => {
      if (!await links.ownedOpen(device, accountId)) throw new Error('Owner SSH link is no longer held')
      return attachSshDeviceRpcPipe(links, device, handlers)
    } })
    let held = false
    try {
      const read = async (request: Parameters<ProjectFileReader>[0]) => {
        if (!await links.ownedOpen(deviceId, accountId)) throw new Error('Owner SSH link is no longer held')
        const response = await requester.call(deviceId, PROJECT_FILE_READ, request, { timeoutMs: 30_000, signal: context.signal })
        if (response.error) throw new Error(`File read refused: ${response.error.code}`)
        return response.result as ProjectFileChunk
      }
      if (context.download) {
        const source = await openProjectFileSource(revision, read)
        held = true
        return { ...source, async dispose() { try { await source.dispose() } finally { requester.closeAll() } } }
      }
      return await snapshotProjectFile(revision, read, tempRoot, context.signal)
    } finally { if (!held) requester.closeAll() } // Detach listeners only; the window still owns the SSH link.
  }
}
