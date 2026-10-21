import { describe, expect, it, vi } from 'vitest'
import {
  handleAgentRetireDeviceCommand,
  type AgentRuntimeBridge,
} from '../../../../packages/core/src/local/agent/deviceCommandRuntime'

const bridge = (retireAgent?: AgentRuntimeBridge['retireAgent']) => ({ retireAgent }) as unknown as AgentRuntimeBridge

// #7199 个人助理搬去了别的设备:旧家拆运行时(agent.retire),❌ 删文件;幂等。
describe('handleAgentRetireDeviceCommand', () => {
  it('交给宿主拆,回显搬去了哪台与撤了几条已安排', async () => {
    const retireAgent = vi.fn(async () => ({ found: true, schedulesRemoved: 2 }))
    const result = await handleAgentRetireDeviceCommand(
      { agent_user_id: 'agent-1', moved_to_device_id: 'dev-cloud', reason: 'moved' },
      { runtimeBridge: bridge(retireAgent) },
    )
    expect(retireAgent).toHaveBeenCalledWith('agent-1')
    expect(result).toEqual({ retired: true, gugu_user_id: 'agent-1', found: true, schedules_removed: 2, moved_to_device_id: 'dev-cloud' })
  })

  it('这台上本来就没有它(重放 / 已经拆过)= 成功,found:false', async () => {
    const result = await handleAgentRetireDeviceCommand(
      { agent_user_id: 'agent-1' },
      { runtimeBridge: bridge(async () => ({ found: false, schedulesRemoved: 0 })) },
    )
    expect(result).toMatchObject({ retired: true, found: false, schedules_removed: 0, moved_to_device_id: null })
  })

  it('宿主没接这一格 = 响亮失败(❌ 说「已拆」其实没拆)', async () => {
    await expect(handleAgentRetireDeviceCommand({ agent_user_id: 'agent-1' }, { runtimeBridge: bridge(undefined) })).rejects.toThrow(/requires the session-page host/)
    await expect(handleAgentRetireDeviceCommand({ agent_user_id: 'agent-1' }, {})).rejects.toThrow(/requires the session-page host/)
  })

  it('没带 agent_user_id = 拒', async () => {
    await expect(handleAgentRetireDeviceCommand({}, { runtimeBridge: bridge(async () => ({ found: true, schedulesRemoved: 0 })) })).rejects.toThrow(/agent_user_id/)
  })

  it('宿主拆失败 = 原样抛出(命令落 error,❌ 吞掉)', async () => {
    const retireAgent = vi.fn(async () => {
      throw new Error('dispose failed')
    })
    await expect(handleAgentRetireDeviceCommand({ agent_user_id: 'agent-1' }, { runtimeBridge: bridge(retireAgent) })).rejects.toThrow('dispose failed')
  })
})
