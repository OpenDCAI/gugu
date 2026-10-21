// 单聊头 agent status 行的引擎段与位置类型 (#994a)。设计稿 chat-single header(gugu-app/index.html line 650):
// 「{状态} · {位置} · {引擎}」,例「在线 · 本机 · Claude Code」。整行由 chatPresentation.localizedAgentHeaderStatus
// 拼(状态那一句取 common:agentStatus.*,位置按语言取),这里只留与语言无关的两件。
import type { AgentType } from '../../agentTypes'

export type AgentLocation = 'local' | 'cloud' | { kind: 'remote'; deviceName: string }

/**
 * 引擎全名(header / 团队卡用)。设计稿 line 650 是「Claude Code」全名；
 * 而 getAgentTypeLabel('claude-code') 返回短名「Claude」(别处徽章用) → 不改它，header 用本函数。
 */
export function agentEngineDisplayName(agentType: AgentType | null | undefined): string | null {
  switch (agentType) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    // @@@1289 云 agent 显式不显引擎段（底层恒 CC，但对用户呈现为「咕咕云端 agent」、绝不暴露引擎）。
    // 原靠 default→null 巧合正确；显式声明意图，防后续误加 'gugu-cloud'→'Claude Code' 漏底层。
    case 'gugu-cloud':
      return null
    default:
      return null
  }
}
