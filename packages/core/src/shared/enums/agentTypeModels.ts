import { VALID_AGENT_TYPES, CLOUD_AGENT_TYPE, type AgentType } from '@gugu/core/agentTypes'
export { DEFAULT_AGENT_TYPE, CLOUD_AGENT_TYPE, type AgentType } from '@gugu/core/agentTypes'

// @@@1289 `VALID_AGENT_TYPES` is the storage/task-page declaration whitelist. It is deliberately
// broader than the ordinary create UI. `AGENT_TYPES` remains a canonical fallback vocabulary for
// non-Electron surfaces and storage validation; Electron selectors obtain their offered set from the
// main-process plugin reachability registry instead of treating this fallback as a capability claim.
export type SelectableAgentType = Exclude<AgentType, typeof CLOUD_AGENT_TYPE>
export const AGENT_TYPES: readonly SelectableAgentType[] = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'hermes',
  'openclaw',
]

// @@@1761 云 agent 判定（对齐 DB chat.is_cloud_agent_user）：agent_type 权威标记 OR
// device_id 'cloud:' 运行时前缀，取并。要点：contacts 的 agent_type 只对自有 agent 富化
//（enrichAgentMetadata），好友的云 agent 只有 device_id 可判——单看 agent_type 会漏。
export function isCloudAgentMarked(c: { agent_type?: string | null; device_id?: string | null }): boolean {
  return c.agent_type === CLOUD_AGENT_TYPE || (c.device_id ?? '').startsWith('cloud:')
}

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && VALID_AGENT_TYPES.includes(value as AgentType)
}

export function nullableAgentType(value: unknown): AgentType | null {
  return isAgentType(value) ? value : null
}

export function getAgentTypeLabel(agentType: AgentType): string {
  switch (agentType) {
    case 'codex':
      return 'Codex'
    case 'claude-code':
      return 'Claude'
    case 'gemini':
      return 'Gemini CLI'
    case 'opencode':
      return 'OpenCode'
    case 'hermes':
      return 'Hermes'
    case 'openclaw':
      return 'OpenClaw'
    // @@@1289/#1759 云 agent 对用户呈现为「Gagent」（咕咕提供的默认 agent 类型），绝不暴露底层引擎。
    // 统一创建流里它是类型网格的首位卡；默认命名序列 = Gagent 1/2/…
    case 'gugu-cloud':
      return 'Gagent'
  }
  return agentType
}
