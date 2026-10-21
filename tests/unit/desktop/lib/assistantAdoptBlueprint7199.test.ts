// @vitest-environment jsdom
// 搬家(adopt):蓝图成员带 existing_agent_user_id,复用身份与私聊 —— 只许 single,不带 first_task / 首句。
import { expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  identityDb: { rpc: vi.fn() },
  getCurrentAuthUserId: async () => 'owner-1',
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
import { buildSingleBlueprint, isProvisionResumeRecord } from '../../../../apps/desktop/src/lib/agentProvision'

const base = {
  provisionId: 'p1',
  memberKey: 'assistant',
  displayName: '小满',
  agentType: 'claude-code',
  inheritMemory: false,
  historyImportRequired: false,
}
const record = (blueprint: unknown) => ({
  version: 2,
  ownerUserId: 'u',
  operationId: 'op',
  deviceId: 'dev',
  blueprint,
  members: [{ provisionId: 'p1', memberKey: 'assistant' }],
})

it('existing_agent_user_id 只在给了才出现', () => {
  expect(buildSingleBlueprint(base).members[0]).not.toHaveProperty('existing_agent_user_id')
  expect(buildSingleBlueprint({ ...base, existingAgentUserId: 'agent-1' }).members[0]).toMatchObject({ existing_agent_user_id: 'agent-1' })
})

it('带着它的恢复记录能通过形状校验;值不是字符串 = 坏记录', () => {
  const adopt = buildSingleBlueprint({ ...base, existingAgentUserId: 'agent-1' })
  expect(isProvisionResumeRecord(record(adopt))).toBe(true)
  expect(isProvisionResumeRecord(record({ ...adopt, members: [{ ...adopt.members[0], existing_agent_user_id: 7 }] }))).toBe(false)
})
