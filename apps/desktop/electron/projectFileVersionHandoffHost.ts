import { attachmentRequest, type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { openHandoff, type PendingHandoff } from '@gugu/core/cloud/fileVersionHandoff'
import type { createProjectFilePublisher } from './projectFilePublication'

/**
 * #791: next versions that members on other machines handed to this host. The device channel's `files.handoff` and every
 * reconnect call this drain. Each copy is decrypted and verified, kept in the project like any upload of an App
 * (`.gugu/attachments`), and written as the requester's next version through the ordinary publisher.
 */
export function createVersionHandoffHost(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>
  endpoint(): Promise<AttachmentsEndpoint>
  publish: ReturnType<typeof createProjectFilePublisher>
}) {
  let running: Promise<void> | undefined
  const attempted = new Set<string>()
  const drain = async () => {
    const identity = await deps.identity(), endpoint = await deps.endpoint()
    const { handoffs } = await attachmentRequest(endpoint, 'file-handoff-pending', { device_id: identity.deviceId }) as { handoffs: PendingHandoff[] }
    const active = new Set(handoffs.map(row => row.id))
    for (const id of attempted) if (!active.has(id)) attempted.delete(id)
    let failed = 0
    for (const row of handoffs) {
      // One attempt per handoff: one that failed stays until its window closes and the requester is told.
      if (row.host_device_id !== identity.deviceId || attempted.has(row.id)) continue
      attempted.add(row.id)
      try {
        const bytes = await openHandoff(endpoint, row)
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        await deps.publish(row.chat_id, { name: row.file_name, contentType: row.content_type, bytes: data }, null, identity.accountId, undefined, { handoff: row.id })
      } catch { failed += 1 }
    }
    if (failed) throw new Error(`${failed} next version handoff(s) were not written`)
  }
  return () => running ??= drain().finally(() => { running = undefined })
}
