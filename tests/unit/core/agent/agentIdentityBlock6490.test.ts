import { describe, expect, it } from 'vitest'
import { buildAgentIdentityBlock } from '@gugu/core/local/agent/deviceCommandRuntime'

// #6490 显示名是可变事实(本机先猜、云端登记撞号抬号、owner 中途改名)。身份块进的是系统提示词,
// 写进去的名字错了就一直错 ⇒ 块里只锚不变的 participant_id,名字要用时 agent 自己调 profile_whoami。
describe('#6490 身份块只锚 participant_id', () => {
  it('不写显示名,也不说「@X 指你」', () => {
    const block = buildAgentIdentityBlock({ guguUserId: 'agent-6490' })
    expect(block).toContain('<agent_identity reason="new_acp_session">')
    expect(block).toContain('participant_id: user:agent-6490')
    expect(block).not.toContain('display_name')
    expect(block).not.toMatch(/@\S+ refers to you/)
  })

  // 集体记忆对账第 5 条:id 和 agent 别处看到的同一个写法,比对的是它真看得到的字段(信封 from_id、history 的 sender_user_id)。
  it('participant_id 带 user: 前缀,认自己的消息按 from_id / sender_user_id', () => {
    const block = buildAgentIdentityBlock({ guguUserId: 'agent-6490' })
    expect(block).toContain('from_id (sender_user_id in message_history) is your participant_id')
    expect(block).not.toContain('sender_id equals')
  })

  it('静态说明两条现成的路:被点名看 message_context 的 you,要名字调 profile_whoami', () => {
    const block = buildAgentIdentityBlock({ guguUserId: 'agent-6490' })
    expect(block).toContain('message_context')
    expect(block).toContain('profile_whoami')
  })

  it('persona 照旧跟在后面', () => {
    expect(buildAgentIdentityBlock({ guguUserId: 'agent-6490', specialFocus: '只做评审' })).toContain('只做评审')
  })
})
