/**
 * Agent 模型选择 —— **纯模块**（无 node import），渲染层（桌面/手机同一套 UI）与主进程共用。
 *
 * #5276 之前这些东西住在 local/agent/modelAccess.ts（带 fs 的本机状态模块）与 deviceCommandRuntime.ts 里，
 * 渲染层只能 import 类型、算不了「这个 agent_type 的引擎说哪条协议」；于是模型面板只能在
 * Electron IPC 后面活着，手机上恒禁用。搬到这里之后：
 *   - 选择的形状与归一化（`AgentModelSelection` / `normalizeAgentModelSelection`）一份；
 *   - 协议 ↔ 凭据面（`MODEL_ACCESS_PROTOCOL_CREDENTIAL_ENV`）一份；
 *   - 引擎 ↔ 协议不在这里：那是各家插件声明的 `platform.wireProtocol`（core 看不见插件，由调用方查好递进来）；
 *   - agent_type ↔ 引擎（`engineIdForAgentType`）一份。
 * 注入闭包（怎么把中转地址与令牌塞进子进程环境）仍留在 local/agent/modelAccess.ts —— 那是主进程的事。
 */
import { CLOUD_AGENT_TYPE, pluginIdForAgentType, type AgentType } from '../agentTypes'

/**
 * 协议 = **线上真正发出去的那个 HTTP 形状**,而不是「这家 harness 读哪个环境变量」。
 *
 * 2026-09-18 之前这两件事被当成一件:表按凭据变量名索引,`OPENAI_API_KEY` 一格既代表 Codex 的
 * Responses,也代表 opencode / qwen / kimi / qoder / copilot 的 chat completions。从前无害 ——
 * 网关那层会做格式转换,进来什么都能落到同一个上游。2026-09-17 减法之后转换整个拆掉,网关改成
 * 按 **incoming_path** 选渠道(AdvancedCustom 类型 58 的 filterAbilitiesByRequestPathAndModel),
 * 于是「发的是哪个形状」变成了硬约束,而这张表答不出这个问题 ——
 * 六家 harness 因此对每一个自营模型都拿到
 * `No available channel for model … under group auto`(#5824,owner 在 opencode 上撞到)。
 *
 * ⇒ 协议从此**自己声明**,不从凭据推导。凭据面另有一张表(MODEL_ACCESS_PROTOCOL_CREDENTIAL_ENV),
 *   两个 OpenAI 协议在那张表里共用 `OPENAI_API_KEY` —— 那正是它们**该**共用的那一维。
 */
export type ModelAccessProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'gemini-generate-content'
export type AgentModelSelection =
  | { source: 'default' }
  | { source: 'byok'; modelId: string }
  | { source: 'platform'; modelId: string; protocol: ModelAccessProtocol }

/**
 * 协议 = 这家 harness 已经在要的那个凭据变量。表按协议键，值是**协议面的规范名**（匹配用，不导出到进程）。
 */
export const MODEL_ACCESS_PROTOCOL_CREDENTIAL_ENV: Record<ModelAccessProtocol, string> = {
  'anthropic-messages': 'ANTHROPIC_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  // 同一把钥匙开两扇门,这是事实而不是疏漏:两个 OpenAI 协议的凭据面逐字相同
  // (`OPENAI_BASE_URL` + `OPENAI_API_KEY`),只有请求路径不同。
  // ⚠️ 因此这张表**推不出协议** —— 协议由各家插件的 `platform.wireProtocol` 声明。
  'openai-chat-completions': 'OPENAI_API_KEY',
  'gemini-generate-content': 'GEMINI_API_KEY',
}

/**
 * 协议 → 它打在网关上的**入站路径**。这是「协议」这个词在本仓的定义,对面是网关上每条
 * AdvancedCustom 渠道路由的 `incoming_path`。
 *
 * 两边必须逐条对得上:网关没声明的路径 = 该协议**一条渠道都选不出来**,请求直接 503
 * `No available channel`。⚠️ 渠道不在本仓里(2026-09-20 起它只住在网关自己的库),所以这条
 * 对账**不是**静态的,分两段盯:部署时网关部署仓的 `configure-gateway-settings.report_channels` 读网关
 * 点名缺哪条路径;平时中台「定价管理」那张矩阵把「某家 harness 一个模型都用不上」显形。
 * ❌ 别只改一边。
 */
export const MODEL_ACCESS_PROTOCOL_GATEWAY_PATH: Record<ModelAccessProtocol, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-responses': '/v1/responses',
  'openai-chat-completions': '/v1/chat/completions',
  // gemini 走它自己那一面(`/v1beta/models/<id>:streamGenerateContent`),而三家上游没有一家
  // 提供原生 generateContent —— 所以网关上**没有**这条路由,目录里也没有任何模型声明这个协议。
  // 留着这一行是为了说清「它为什么是空的」,❌ 不是承诺有路。
  'gemini-generate-content': '/v1beta/models',
}

export const MODEL_ACCESS_PROTOCOL_IDS = Object.keys(
  MODEL_ACCESS_PROTOCOL_CREDENTIAL_ENV,
) as ModelAccessProtocol[]

/**
 * 把一条**存下来的**选择对齐到这个引擎当下的线协议。
 *
 * 协议从来不是用户选的 —— 它由引擎定(插件声明的 `platform.wireProtocol`,宿主查好递进来)。可它当年是和用户的选择
 * 一起被写进 agent 记录的,于是它是一份**派生值的副本**,而副本会过期:#5824 把 opencode /
 * copilot 拧到 responses、把 qwen / kimi / qoder 归到 chat completions 之后,所有在那之前存下来的
 * 选择里那一栏全是旧的。
 *
 * 旧副本的下场不是报错而是**更坏的静默**:签发令牌时按旧协议发白名单(`issuePlatformModelAccess`),
 * 而 harness 按新协议发请求 —— 两个协议的别名大多相同,所以多数情况「照样能跑」,只是计费那一栏
 * 记错了协议;碰到只在一条协议上架的型号(kimi-k2.7-code 只有 messages 与 chat)就直接被白名单拒。
 *
 * ⇒ 读的时候以引擎为准。❌ 不做数据迁移:派生值就该在用的时候重新算,写一次迁移只是把同一个
 *   副本刷新到下一次漂移之前。
 */
export function agentModelSelectionForProtocol(
  selection: AgentModelSelection,
  /** 这个引擎当下的线协议;null = 引擎认不出来或没接平台模型。 */
  protocol: ModelAccessProtocol | null,
): AgentModelSelection {
  if (selection.source !== 'platform') return selection
  // 引擎认不出来时**保持原样**:那是「这个 id 不是咕咕承认的引擎」,由调用方各自的门去拒,
  // ❌ 不在这里悄悄把协议抹掉。
  if (!protocol || protocol === selection.protocol) return selection
  return { ...selection, protocol }
}

export function isModelAccessProtocol(value: unknown): value is ModelAccessProtocol {
  return typeof value === 'string' && value in MODEL_ACCESS_PROTOCOL_CREDENTIAL_ENV
}

export function normalizeAgentModelSelection(value: unknown): AgentModelSelection {
  if (!value || typeof value !== 'object') return { source: 'default' }
  const row = value as Record<string, unknown>
  if (row.source === 'default') return { source: 'default' }
  const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : ''
  if (row.source === 'byok' && modelId) return { source: 'byok', modelId }
  if (row.source === 'platform' && modelId && isModelAccessProtocol(row.protocol)) {
    return { source: 'platform', modelId, protocol: row.protocol }
  }
  return { source: 'default' }
}

/**
 * Which engine an agent of this type IS — a label, derived purely from its type.
 *
 * A local agent type is its engine id (the session-page plugin id); only `claude-code` is spelled
 * differently. Whether that engine can run Gugu's models is a separate question answered by its
 * plugin's `platform` declaration. #6212: a second hand-kept type → engine list here stopped at the
 * six #1229 types, so copilot (and pi/qwen/kimi/…) read as "cannot use models provided by Gugu"
 * while their sessions were running on one.
 *
 * Historical `cache.acp_engine_id` values are deliberately ignored: Gugu no longer owns a
 * parallel ACP runtime for that key to select.
 */
export function engineIdForAgentType(agentType: AgentType): string | null {
  if (agentType === CLOUD_AGENT_TYPE) return null
  return pluginIdForAgentType(agentType)
}
