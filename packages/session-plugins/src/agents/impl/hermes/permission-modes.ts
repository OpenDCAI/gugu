import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Hermes Agent over `hermes serve` —— 会话级 `config.set {key:'yolo', session_id}` 两档(桥报成 ACP `mode`):
 *   default — Hermes 自己的审批:危险命令(`approvals.mode`:manual / smart)先问,改文件不问(serve 下写文件从不询问)
 *   yolo    — 一律放行(会话级,换回 default 即撤回;❌ 不是进程级的 `HERMES_YOLO_MODE`)
 * Phase 0(v2026.9.24 与 main ddde0670):default 下 `rm -rf` 发 approval,答 deny 后目录还在。
 *
 * ⇒ ❌ 没有只读档:只读的承诺是「动手或跑命令前都先问」,而 default 下改文件、普通命令都不问
 *    (@@@permission-three-modes)。也没有规划档。
 * · `edit` 取 `default`:工作区里改文件、跑命令都不问,危险命令仍问。
 * · `full-access` 取 `yolo`。
 */
export const HERMES_PERMISSION_MODES = {
  edit: { id: 'default' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
