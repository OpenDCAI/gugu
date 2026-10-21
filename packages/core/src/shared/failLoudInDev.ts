// @@@1680 dev-fail-loud gate for the delivery / routing RESOLUTION path. owner 令（开发阶段）：一个
// 「本应解析成功」的值（listen_mode、agent 名、thread 历史、群成员名表）若解析失败，**不准**静默回落默认
// 值后继续投递——那会掩盖 parse/lookup 失败，让 e2e 在降级行为上假绿（agent 用错的 listen_mode / 用 id 顶替
// 名字 / 丢上下文 仍回复，测试照过）。
//
// 在 dev/test（`GUGU_DEV_FAIL_LOUD=1`，由 e2e harness 在 Electron launch env 注入）→ **抛错**，让失败浮到
// 主进程 stderr（被 _mainProcessGuard 捕获，spec 红）。在 prod（flag 未设）→ 保留原有的优雅回落，让瞬时抖动
// 不致整体停摆。
//
// 为什么用 env 而非 `import.meta.env.DEV`：投递/路由这些代码打进 **主进程 bundle**（dist-electron/main.js），
// 那里没有 vite 注入的 `import.meta.env.DEV`（production build 恒 false），故必须用运行时 env 变量门控。
//
// 范围边界：只门控**数据层「本应解析成功」的失败**，不碰有意的分层兜底（原例 embedding router→LLM gate
// 已随 #2008 删除;现例如引擎 bundled bin 缺失 → 退 PATH 解析,那是设计的降级非 parse 失败）、也不碰真实空态/用户输入默认（空群名 → '群聊'）。

export function isDevFailLoud(): boolean {
  // Renderer-safe: these helpers also live in modules that vite may bundle into the renderer, where
  // `process` is undefined → optional-chain to undefined (→ false, no-op) so we never throw a ReferenceError.
  return typeof process !== 'undefined' && process.env?.GUGU_DEV_FAIL_LOUD === '1'
}

/**
 * Dev/test：把这次「本应解析成功」的失败 **loudly 报到主进程 stderr**，让它被 e2e 的 _mainProcessGuard 捕获
 * → spec 红（解析失败不再被静默兜底掩盖）。调用方随后仍走原回落，所以**不抛错**——避免在主进程 device-runtime
 * tick 里抛未捕获异常炸掉后续 spec；guard 红 + stderr 告警已是足够 loud 的失败信号。
 * Prod（flag 未设）：完全 no-op，行为与改动前一致。
 *
 * 前缀 `[device-runtime] dev-fail-loud` 是刻意的：_mainProcessGuard 的捕获正则要求 `[device-runtime]`/`[acp…]`
 * 域标记 + 信号词（fail/error/…），这里两者都带 → 必被捕获。`context` 标识失败点；`cause` 可选原始错误。
 */
export function failLoudInDev(context: string, cause?: unknown): void {
  if (!isDevFailLoud()) return
  const detail = cause === undefined ? '' : `: ${String((cause as Error)?.message ?? cause)}`
  console.error(`[device-runtime] dev-fail-loud #1680 — ${context}${detail}`)
}
