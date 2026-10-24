import { expect, it, vi } from 'vitest'
import { watchAssistantMemory } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-memory-watch'
import type { AssistantMachine } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import type { FileChangesEvent } from '../../../apps/desktop/src/session/shared/core/fs/fsEvents'

it('refreshes the owning workspace after registration and changes, releasing a late lease on close', async () => {
  const gate = Promise.withResolvers<{ success: true; data: { leaseId: string } }>()
  const releaseDirectoryWatch = vi.fn(async () => {})
  const machine = { projectId: 'project', workspaceId: 'workspace', paths: { memoryDir: '/home/memory' },
    rpc: { workspace: { files: { watchDirectory: vi.fn(() => gate.promise), releaseDirectoryWatch } } } } as unknown as AssistantMachine
  let receive!: (event: FileChangesEvent) => void
  const unsubscribe = vi.fn(); const changed = vi.fn(); const failed = vi.fn()
  const close = watchAssistantMemory(machine, handler => { receive = handler; return unsubscribe }, changed, failed)
  receive({ projectId: 'other', workspaceId: 'workspace' } as FileChangesEvent)
  expect(changed).not.toHaveBeenCalled()
  receive({ projectId: 'project', workspaceId: 'workspace' } as FileChangesEvent)
  expect(changed).toHaveBeenCalledTimes(1)
  close(); gate.resolve({ success: true, data: { leaseId: 'lease' } })
  await vi.waitFor(() => expect(releaseDirectoryWatch).toHaveBeenCalledWith('project', 'workspace', 'lease'))
  receive({ projectId: 'project', workspaceId: 'workspace' } as FileChangesEvent)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(failed).not.toHaveBeenCalled()
})

it('does not present a rejected subscription as a successful live view', async () => {
  const machine = { projectId: 'p', workspaceId: 'w', paths: { memoryDir: '/memory' }, rpc: { workspace: { files: {
    watchDirectory: vi.fn(async () => ({ success: false })),
  } } } } as unknown as AssistantMachine
  const failed = vi.fn(); const changed = vi.fn()
  const close = watchAssistantMemory(machine, () => () => {}, changed, failed)
  await vi.waitFor(() => expect(failed).toHaveBeenCalled())
  expect(changed).not.toHaveBeenCalled()
  close()
})
