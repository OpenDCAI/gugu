import { describe, it, expect, vi, beforeEach } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { functions: { invoke: mocks.invoke } },
  chatDb: { from: vi.fn() },
  identityDb: { from: vi.fn() },
}))
import { generateAgentTeam } from '../../../../apps/desktop/src/lib/teamGenerate'
const RESPONSE = {
  teamName: '数学讨论班',
  members: [
    { role: '主讲', displayName: '诺特', description: '讲抽象代数', engineId: 'codex' },
    { role: '主讲', displayName: '狄拉克', description: '讲量子力学', engineId: 'codex' },
  ],
}
describe('LLM 生成的团队成员必须带稳定的 blueprint 槽位 key', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue({ data: RESPONSE, error: null })
  })
  it('每个成员都有非空 avatarSeed，且就是它的 blueprint 槽位 key', async () => {
    const team = await generateAgentTeam('搭一个数学物理讨论班')
    expect(team.members).toHaveLength(2)
    for (const member of team.members) {
      expect(member.avatarSeed?.trim(), `${member.displayName} 缺模板 key`).toBeTruthy()
      expect(member.avatarSeed, '模板 key 应就是 blueprint 槽位 key').toBe(member.tempId)
    }
  })
  it('模板 key 不由角色标签或显示名派生（同 role 的两个成员不得撞 key）', async () => {
    const team = await generateAgentTeam('搭一个数学物理讨论班')
    const [a, b] = team.members
    expect(a.role).toBe(b.role) // 前提：两人同 role
    expect(a.avatarSeed).not.toBe(b.avatarSeed)
    for (const member of team.members) {
      expect(member.avatarSeed).not.toBe(member.role)
      expect(member.avatarSeed).not.toBe(member.displayName)
    }
  })
})
