import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * ZCode(经 `@gugu-acp/zcode-acp` 1.0.0,CLI 0.16.9)—— `session/new` 自报五档(configOption `mode`):
 *   plan / build / edit / guarded / yolo(ZCode 自己界面上的名字:Plan / Ask before changes /
 *   Edit automatically / —— / Full access)。
 *
 * 行为读数(2026-10-17,ThinkPad,glm-4.6;每档新起会话,同一句「写一个文件,再跑一条 Bash」,
 * 客户端对每次询问都答 reject_once ⇒「问了」即「没执行」;装置 gugu-base
 * `notes/2026-10-16-zcode-harness/app-server-probe/acp-modes.mjs`,读数在同目录 gugu-acp桥-实测与上游草稿.md):
 *   · `plan`  → 只申请退出计划模式(被拒),文件没写、命令没跑
 *   · `build` → Write 与 Bash **都先问**,拒后都没执行
 *   · `edit`  → Write 直接执行,Bash 先问
 *   · `yolo`  → 都不问,都执行
 * ⇒ `read-only`(改东西前先问,与 claude 的 default 同义)取 `build`;`edit` 取 `edit`;
 *   `full-access` 取 `yolo`;`plan` 取 `plan`。`guarded`(全放行、只危险命令问)不对应咕咕任何一档,不摆。
 */
export const ZCODE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'build' },
  edit: { id: 'edit' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
