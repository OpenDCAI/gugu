import type { AssistantMachine } from './assistant-machine-core'
import type { FileChangesEvent } from '@shared/core/fs/fsEvents'

/** A visible memory view borrows the existing workspace directory watch; no polling or agent messages. */
export function watchAssistantMemory(machine: AssistantMachine,
  subscribe: (receive: (event: FileChangesEvent) => void) => () => void,
  changed: () => void, failed: (error: unknown) => void): () => void {
  let closed = false
  const stop = subscribe(event => {
    if (!closed && event.projectId === machine.projectId && event.workspaceId === machine.workspaceId) changed()
  })
  const files = machine.rpc.workspace.files
  const lease = files.watchDirectory(machine.projectId, machine.workspaceId, machine.paths.memoryDir)
    .then(result => {
      if (!result.success) throw new Error('Memory directory watch is unavailable')
      // Re-read after subscribing so a write racing initial fetch/watch registration cannot be lost.
      if (!closed) changed()
      return result.data.leaseId
    }).catch(error => { if (!closed) failed(error); return null })
  return () => {
    closed = true; stop()
    void lease.then(id => {
      if (id) void files.releaseDirectoryWatch(machine.projectId, machine.workspaceId, id).catch(failed)
    })
  }
}
