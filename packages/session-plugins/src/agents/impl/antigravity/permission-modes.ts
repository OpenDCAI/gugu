import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Antigravity(官方 ACP 服务 `agy_acp_server` 1.1.1)—— `session/new` 自报三档,逐字(2026-09-23 MBP):
 *   default   — "Default permission prompt flow"
 *   auto_edit — "Auto-approve file edit tools"
 *   yolo      — "Auto-approve all tools"
 *
 * 行为读数(假 Gemini 端点回 `run_command` functionCall,数 `session/request_permission`):
 *   · `default`                     → 1 次询问(kind execute);allow_once 命令真跑、reject_once 没跑
 *   · `session/set_mode(auto_edit)` → 仍 1 次询问(execute 不在「编辑」之列),reject 后没跑
 *   · `session/set_mode(yolo)`      → 0 次询问,命令直接执行
 * ⇒ default 与 yolo 判得出真假;auto_edit 与 default 在 execute 上同形 —— 它俩的差别只在编辑类工具,
 *    那一半**没量**(假端点没回写文件的 functionCall),映射取的是厂商自述。
 *
 * 映射照 hermes 同形(它也是「default 问、accept_edits 放编辑、dont_ask 全放」三档):
 * · `read-only` 取 `default` —— 每一步动手都先问,与 claude/hermes 把 `default` 归只读档同义;
 * · `edit` 取 `auto_edit`;`full-access` 取 `yolo`。
 * · 没有 `plan` 档:它自报的三档里没有,❌ 不为凑格子摆一个不存在的档。
 */
export const ANTIGRAVITY_PERMISSION_MODES = {
  // 只读只在聊天面板腿(ACP `default`)。终端腿的 agy 1.4.0 `--mode` 只认 accept-edits / auto / plan,
  // `--mode default` 只打一行 warning 就照常起(落到用户自己存的档);shell 另由 toolPermission 管 ⇒ 终端腿兑现不了只读。
  'read-only': { id: 'default', legs: ['acp'] },
  edit: { id: 'auto_edit' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
