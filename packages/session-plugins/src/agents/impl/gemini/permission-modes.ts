import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Gemini CLI —— 它在 ACP `session/new` 的回包里**自报四档**，逐字（实测 0.57.0，2026-09-01）：
 *   default  — "Prompts for approval"
 *   autoEdit — "Auto-approves edit tools"
 *   yolo     — "Auto-approves all tools"
 *   plan     — "Read-only mode"
 *
 * 行为读数（假 Gemini 端点回 `write_file` functionCall，数 `session/request_permission`，
 * 三档互不相同 ⇒ 判据能判假）：
 *   · `default`                 → 1 次询问，拒绝后工具真的没跑
 *   · `session/set_mode(yolo)`  → 0 次询问，工具直接执行完成
 *   · `session/set_mode(plan)`  → 0 次询问，工具**被拦**（tool_call_update: failed）
 *
 * 映射对齐 codex/claude 同名档的语义：
 * · `edit` 取 `autoEdit` —— 官方措辞与 claude `acceptEdits` 同义（只放行编辑类工具）。
 *   ⚠️ 与 kimi 不同：kimi 的 `edit` 落在它的 `default`，因为 kimi 没有「只放编辑」档；
 *   gemini 恰好有，别照抄 kimi。
 * · `full-access` 取 `yolo`（官方原文 "Auto-approves all tools"）。
 * · 没有独立只读档：`plan` 的官方描述就是 "Read-only mode"，但它同时是规划语义，
 *   与 claude 把 `default` 归 read-only 的情况不同 —— 不为凑格子把 plan 兼作 read-only。
 */
export const GEMINI_PERMISSION_MODES = {
  plan: { id: 'plan' },
  edit: { id: 'autoEdit' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
