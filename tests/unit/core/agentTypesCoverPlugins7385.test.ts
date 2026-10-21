import { describe, expect, it } from 'vitest'
import { normalizeAgentType } from '@gugu/core/agentTypes'
import { pluginRegistry } from '@gugu/session-plugins/agents'

/**
 * 每一家登记的 harness 都得是合法的 agent 类型 —— 新建 agent 时 `sessionpage:ensure-agent-address` 用插件 id
 * 过 `normalizeAgentType`,名单里没有就整条新建失败(#7385:mac1 上新建 ZCode agent 报
 * 「Unsupported agent type: zcode」,而声明、门、单测全绿)。库里 `identity.agent_profiles` 的 CHECK 是同一份名单
 * (gugu-supabase),两边一起加。
 */
describe('agent type whitelist covers every registered harness', () => {
  it.each(pluginRegistry.getAll().map((p) => p.metadata.id))('%s', (id) => {
    expect(() => normalizeAgentType(id)).not.toThrow()
  })
})
