import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * Kimi Code —— 它在 ACP `session/new` 的回包里**自报四档**，逐字：
 *   default — "Manual approvals; tools execute normally."
 *   plan    — "Read-only planning; no tool execution."
 *   auto    — "Auto-approve safe operations."
 *   yolo    — "Auto-approve everything."
 *
 * 实测 @moonshot-ai/kimi-code@0.38.0（2026-08-25，单变量对照矩阵，两个读数都双向变过）：
 *   · `default` / 不声明 → ACP 上发 1 次 `session/request_permission`
 *   · `auto` / `yolo`    → **0 次**，工具直接执行（Bash 探针同样 1 → 0）
 *   · `plan`             → 0 次且工具**被拦**，理由显式：
 *     `Plan mode is active. You may only write to the current plan file: …`
 *   · `manual` + 客户端答 reject → 工具真的没跑
 *     （`Tool "Write" was not run because the user rejected the approval request.`）
 *
 * ⚠️ **没有只读档**：`plan` 是「只出方案、连动手的意图都不许有」，不是「能看不能动」。
 *    ❌ 不为凑满四格把 plan 兼作只读 —— 那正是 @@@permission-three-modes 记的
 *    「界面上不摆不存在的档」。
 *
 * ⚠️ `full-access` 取 `yolo` 而不是 `auto`：两者实测都不再询问，但 `auto` 的官方措辞是
 *    「auto-approve **safe** operations」，那是「它自己判断哪些安全」，与用户选的「完全访问」
 *    不是一回事。取字面对得上的那一个。
 *
 * ⚠️ ❌ 别改成 argv：`--auto` / `--yolo` 在 `kimi acp` 上是**静默 no-op** ——
 *    放在 `acp` 前后都被接受、退出码 0、行为等于基线。阳性对照：同位置的
 *    `--permission-mode yolo` 会报 `error: unknown option`，说明这条路确实会拒未知 flag，
 *    所以 `--auto` 是被**吃掉**而不是被拒。
 */
/*
 * full-access 取 `yolo`:kimi 自己最松的一档。⚠️ 它不是「什么都不问」—— 0.40.1 实测(假上游回一次 Bash,
 * 探针拒绝所有批准请求):`touch` 0 次询问照跑;`touch && rm -rf` **问 1 次**。这是 kimi 自己的行为,咕咕不替它放宽。
 * ❌ 别换成 `auto`:同一探针下 `auto` 对 `rm -rf` 0 次询问、直接拦(「blocked in auto permission mode because it is
 * considered dangerous」),比 yolo 更窄。读数见 gugu-base evidence/2026-10-17-pty-permission-mode/kimi-acp/。
 */
export const KIMI_PERMISSION_MODES = {
  plan: { id: 'plan' },
  edit: { id: 'default' },
  'full-access': { id: 'yolo' },
} satisfies ProviderPermissionModeMap;
