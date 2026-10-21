export const DEFAULT_AGENT_TYPE = 'claude-code'
// #1229 ACP 引擎扩充 — 2→6 款。外部 CLI agent（`<cli> acp`/`--acp`）。
// ⚠️ 当年这批引擎的启动命令登记在已退役的引擎表里，由 `engine-launch.ts` 读表 spawn。
// 那条路整条退役了(表见 20260826180000，启动器随会话页后端接管引擎 spawn 一并删除)——
// 下面这些值今天**只是 agent 的类型标签**，不再对应任何注册表行。
// 刀1 gemini(`gemini --acp`)、刀2 opencode(`opencode acp`)、刀3 hermes(`hermes acp`,
// NousResearch/hermes-agent 的 ACP server 模式)、刀4 openclaw(`openclaw acp`, openclaw/acpx
// bridge mode；补齐第 6 款，替换 seed 里未接 UI 的 pi)。dev11 未装→降级 bar：preflight fail-loud 站住。
// @@@1289 'gugu-cloud' = 云 agent 的固定 runtime 标记（type-agnostic，底层恒为 cage-CC）。它是
// 合法的存储/类型值，但**不是用户可选的引擎**（不进 AGENT_TYPES 选择器）也**不是可本机 spawn 的引擎**
// （AgentRuntimeKind 仍只六款 CLI engine）。仅作「这是云 agent」的标记，UI 显示为「云端 Agent」。
export const CLOUD_AGENT_TYPE = 'gugu-cloud'
export const VALID_AGENT_TYPES = [
  'claude-code', 'codex', 'gemini', 'opencode', 'hermes', 'openclaw', 'gugu-cloud',
  'grok', 'devin', 'qwen', 'droid', 'antigravity', 'cursor', 'copilot', 'amp',
  'commandcode', 'charm', 'auggie', 'goose', 'kimi', 'kilocode', 'kiro', 'rovo',
  'cline', 'continue', 'codebuff', 'freebuff', 'mistral', 'jules', 'junie',
  'oh-my-pi', 'pi', 'qoder', 'letta', 'autohand', 'mimocode', 'zero', 'zcode',
  'codebuddy',
] as const
export type AgentType = typeof VALID_AGENT_TYPES[number]

/** 存的 agent 类型 → 会话页插件 id:只有 claude 拼法不同(存 `claude-code`,插件叫 `claude`),全仓只在这里翻译。 */
export function pluginIdForAgentType(agentType: string): string {
  return agentType === 'claude-code' ? 'claude' : agentType
}

export function normalizeAgentType(agentType: string | null | undefined): AgentType {
  if (!agentType) return DEFAULT_AGENT_TYPE
  const raw = agentType.trim().toLowerCase()
  if (raw === 'claude' || raw === 'claude-code' || raw === 'cc') return 'claude-code'
  if (raw === 'codex') return 'codex'
  if (raw === 'gemini' || raw === 'gemini-cli') return 'gemini'
  if (raw === 'opencode') return 'opencode'
  if (raw === 'hermes') return 'hermes'
  if (raw === 'openclaw') return 'openclaw'
  if (raw === 'gugu-cloud') return 'gugu-cloud'
  if ((VALID_AGENT_TYPES as readonly string[]).includes(raw)) return raw as AgentType
  throw new Error(`Unsupported agent type: ${agentType}`)
}
