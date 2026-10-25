/**
 * Agent/技能分类枚举
 * 9 个预定义分类，供 agent_profiles.category 字段使用
 */

export const AGENT_CATEGORIES = [
  'ai-coding',
  'productivity',
  'writing',
  'finance',
  'lifestyle',
  'data',
  'integrations',
  'security',
  'utility',
] as const

export type AgentCategory = (typeof AGENT_CATEGORIES)[number]

export const AGENT_CATEGORY_LABEL: Record<AgentCategory, string> = {
  'ai-coding': 'AI 编程',
  productivity: '效率工具',
  writing: '写作助手',
  finance: '金融理财',
  lifestyle: '生活方式',
  data: '数据分析',
  integrations: '系统集成',
  security: '安全防护',
  utility: '实用工具',
}

export function isAgentCategory(value: unknown): value is AgentCategory {
  return typeof value === 'string' && (AGENT_CATEGORIES as readonly string[]).includes(value)
}
