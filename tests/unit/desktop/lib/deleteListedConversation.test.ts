import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), archive: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { from: state.from, rpc: state.rpc } }))
vi.mock('../../../../apps/desktop/src/lib/groupAdmin', () => ({ currentGroupAdmin: async () => ({ archive: state.archive }) }))
import { hideListedConversation } from '../../../../apps/desktop/src/lib/hideListedConversation'
const receipt = { chat_id: 'group', operation_id: 'operation', hidden_at: '2026-11-06T17:00:00Z', account_revision: '9007199254740993' }
beforeEach(() => { vi.clearAllMocks(); state.rpc.mockResolvedValue({ data: receipt, error: null }) })
it('uses only the personal RPC and preserves its exact decimal revision', async () => {
  expect(await hideListedConversation('group', 'operation')).toEqual(receipt)
  expect(state.rpc).toHaveBeenCalledExactlyOnceWith('hide_my_conversation', { p_chat_id: 'group', p_operation_id: 'operation' })
  expect(state.from).not.toHaveBeenCalled()
  expect(state.archive).not.toHaveBeenCalled()
})
it.each([{ chat_id: 'other' }, { operation_id: 'other' }, { account_revision: 42 }, { account_revision: '1e4' }, { hidden_at: 'invalid' }])('rejects an unconfirmed receipt %j', async (patch) => {
  state.rpc.mockResolvedValue({ data: { ...receipt, ...patch }, error: null })
  await expect(hideListedConversation('group', 'operation')).rejects.toThrow('Conversation hiding was not confirmed')
})
it('propagates server denial without invoking group management', async () => {
  state.rpc.mockResolvedValue({ data: null, error: { message: 'conversation_hide_membership_required' } })
  await expect(hideListedConversation('group', 'operation')).rejects.toThrow('conversation_hide_membership_required')
  expect(state.archive).not.toHaveBeenCalled()
})
