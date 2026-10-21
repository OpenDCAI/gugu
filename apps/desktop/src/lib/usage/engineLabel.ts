import { agentIcons } from '@gugu/session-plugins/agent-icons'
import { pluginIdForAgentType } from '@gugu/core/agentTypes'

/** 引擎的显示名:插件自己声明的品牌名;没有登记的类型原样显示 id,❌ 不编一个名字。 */
export function engineLabel(engine: string): string {
  return agentIcons[pluginIdForAgentType(engine)]?.alt ?? engine
}
