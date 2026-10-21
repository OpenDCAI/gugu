import type { SessionTuiDeliveryToolNames } from '@gugu/session-core/agents/plugins';

/**
 * 投递面引用的工具名只有这一份 canonical(bare)声明;provider-visible 全名 = harness 在
 * `capabilities.mcp.toolNames` 声明的前缀 + canonical,由 `resolveSessionTuiDeliveryToolNames` 组合。
 * ❌ 不在 provider impl 里逐字重写全名 —— 那要求每次工具面改名都多处 lockstep,漏一处就是某个
 * provider 广告一个 server 不再注册的名字,而投递记账静默丢失(#4191 code-review finding)。
 */
export const CANONICAL_SESSION_TUI_DELIVERY_TOOL_NAMES = {
  message: 'message_send',
} as const satisfies SessionTuiDeliveryToolNames;
