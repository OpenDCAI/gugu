import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Qwen Code 0.24.4 `--approval-mode` / ACP `session/set_mode` 五档:`plan | default | auto-edit | auto | yolo`
 * (#6221 厂商层实测,2026-09-23,macOS 裸 ACP + 假端点):
 * · 无 flag 起始模式是 **`auto`**(源码 QwenLM/qwen-code@v0.24.4 `packages/cli/src/config/config.ts:1836-1858`)——
 *   工作区内写入走快路径**不问** ⇒ 咕咕从前「Edit 不发 flag」实际落在这里。
 * · `default`:编辑与 shell 都问,拒绝后副作用确实没发生 ⇒ 对齐咕咕 `read-only`(与 claude `default` 同位)。
 * · `plan`:全拦 ⇒ `plan`。`yolo`:全放 ⇒ `full-access`。
 * · **不声明 `edit`**:五档里没有一档兑现「在工作区内改文件、跑命令」—— `auto-edit` 对任意路径的写入都放行
 *   (qwen 不开沙箱时没有工作区牢笼),`auto` 由分类器裁决。选了 Edit 的会话按
 *   `resolveDeclaredPermissionMode` 落到不比它更松的最近一档(`read-only` = `default`)。
 */
export const QWEN_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
