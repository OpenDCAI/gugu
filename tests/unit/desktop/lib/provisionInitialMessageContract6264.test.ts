// @vitest-environment jsdom
// 首条消息的 RPC 契约:库里(start_agent_provision_operation 的 4567 包装)只收 {text, client_message_id},
// 多一个键整条拒绝。客户端曾原样传 {messageId, text},带首条消息新建 Codex 恒失败(#6264 在咕咕 server 上实测撞到)。
import { expect, it, vi } from 'vitest'
const rpc = vi.fn(async () => ({ data: { id: 'op-1', phase: 'running' }, error: null }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { rpc: (...a: unknown[]) => (rpc as (...b: unknown[]) => unknown)(...a) },
  getCurrentAuthUserId: async () => 'owner-1',
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
import { startProvisionOperation, buildSingleBlueprint } from '../../../../apps/desktop/src/lib/agentProvision'

it('首条消息按库里的键名传:text + client_message_id', async () => {
  const blueprint = buildSingleBlueprint({
    memberKey: 'single', displayName: 'Codex 1', agentType: 'codex', projectPath: '/home/alice',
    inheritMemory: false, historyImportRequired: false, memorySources: [], provisionId: 'p-1',
  })
  await startProvisionOperation('op-1', 'dev-1', blueprint, undefined, { messageId: 'm-1', text: '你好' })
  expect(rpc).toHaveBeenCalledWith('start_agent_provision_operation', expect.objectContaining({
    p_initial_message: { text: '你好', client_message_id: 'm-1' },
  }))
})

it('选了模型 / 思考强度 / 权限模式就带上;没选恒传 null', async () => {
  const blueprint = buildSingleBlueprint({
    memberKey: 'single', displayName: 'Codex 1', agentType: 'codex', projectPath: '/home/alice',
    inheritMemory: false, historyImportRequired: false, memorySources: [], provisionId: 'p-2',
  })
  rpc.mockClear()
  await startProvisionOperation('op-2', 'dev-1', blueprint, undefined, undefined, {
    model: 'platform:gpt-5.6-sol', effort: 'high', permissionMode: 'full-access',
  })
  expect(rpc).toHaveBeenLastCalledWith('start_agent_provision_operation', expect.objectContaining({
    p_model: 'platform:gpt-5.6-sol', p_effort: 'high', p_permission_mode: 'full-access',
  }))
  await startProvisionOperation('op-3', 'dev-1', blueprint, undefined, undefined, { model: null })
  expect(rpc).toHaveBeenLastCalledWith('start_agent_provision_operation', expect.objectContaining({
    p_model: null, p_effort: null, p_permission_mode: null,
  }))
  await startProvisionOperation('op-4', 'dev-1', blueprint)
  expect(rpc).toHaveBeenLastCalledWith('start_agent_provision_operation', expect.objectContaining({
    p_model: null, p_effort: null, p_permission_mode: null,
  }))
})
