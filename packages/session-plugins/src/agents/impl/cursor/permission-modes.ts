import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Cursor Agent ACP (`2026.08.31-4057e58`, mac1 GUI bootstrap `session/new`) 自报三档：
 * `agent` — "Full agent capabilities with tool access"；
 * `plan` — "Read-only mode for planning and designing before implementation"；
 * `ask` — "Q&A mode - no edits or command execution"。
 *
 * 行为对照（同一 GUI/keychain 会话，三档各一次）与自述一致：agent 实写
 * `PROBE-agent.txt` 并回 AGENT-DONE；plan 拒绝写入并返回计划；ask 明确拒绝编辑；
 * 短任务三次均 0 `session/request_permission`（长任务可出现询问，取决于工具）。因此 plan 对齐 gugu `plan`，ask 对齐
 * `read-only`，agent 对齐 `full-access`；Cursor 没有 edit 档。
 */
export const CURSOR_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'ask' },
  'full-access': { id: 'agent' },
} satisfies ProviderPermissionModeMap;
