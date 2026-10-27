import { expect, it, vi } from 'vitest'
import { applyAssistantPanelService } from '../../apps/desktop/electron/sessionpage/assistant-panel-service'
import type { AssistantPanelChange, AssistantPanelCommit } from '@gugu/core/cloud/assistantPanel'

const change: AssistantPanelChange = { operation_id: 'edit',assistant_user_id: 'assistant',owner_user_id: 'owner',domain: 'schedules',resource_key: 'gone',
  device_id: 'home',revision: '9',operation: 'save',payload: { data: { title: 'Changed' } },status: 'pending',error_code: null }
it('reconciles a natively removed schedule into a newer deletion rather than leaving an impossible pending edit', async () => {
  const commit = vi.fn(async (_assistant: string,_change: AssistantPanelCommit) => ({ status: 'pending' })), apply = vi.fn(async () => { throw new Error('PANEL_RESOURCE_REMOVED') })
  await expect(applyAssistantPanelService(change,apply,{ commit } as never)).rejects.toThrow('PANEL_RESOURCE_SUPERSEDED')
  expect(commit).toHaveBeenCalledWith('assistant',expect.objectContaining({ domain: 'schedules',key: 'gone',operation: 'remove',expectedRevision: '9' }))
  expect(commit.mock.calls[0]![1]).not.toHaveProperty('runtimeInstanceId')
})
it('does not delete an existing schedule owned by another assistant', async () => {
  const commit = vi.fn(), apply = async () => { throw new Error('PANEL_SCHEDULE_NOT_OWNED') }
  await expect(applyAssistantPanelService(change,apply,{ commit } as never)).rejects.toThrow('PANEL_SCHEDULE_NOT_OWNED')
  expect(commit).not.toHaveBeenCalled()
})
