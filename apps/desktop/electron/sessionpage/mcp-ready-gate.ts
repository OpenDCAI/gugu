import { createLogger } from '../lib/logger'

/**
 * 「这条会话的 gugu MCP 已经被引擎列过工具」—— 首句走 local-session 的终端腿的启动门
 * (`EmdashPtyCommandOverride.startupGate`)。事实来源与 claude TUI 的投递就绪同一个:宿主为这条会话的
 * grant 送出 `tools/list` 应答(`GuguMcpHost.onToolsListed`,#4896)。
 *
 * 为什么要等:Antigravity `agy` 在工具列出之前收到的那一轮,模型请求里没有咕咕的工具
 * (2026-09-24 实测,`impl/antigravity/index.ts` 的 `prompt`)。
 *
 * ⚠️ 预算只是「一直没就绪」的兜底边界,❌ 不是延时:正常路径上门在 `tools/list` 那一刻就开。
 *    到点仍没来 ⇒ 记一条警告、照样开门 —— 消息照送(那一轮没有咕咕工具),❌ 不让用户的消息卡死在门外。
 *    MCP 起不来本身另有报告(能力加载报告里的 mcp 单元)。
 */
export const MCP_READY_GATE_BUDGET_MS = 60_000

export interface ToolsListedSource {
  onToolsListed(key: string, listener: () => void): () => void
}

export function guguMcpToolsListedGate(
  host: ToolsListedSource,
  grantKey: string,
  sessionId: string,
  budgetMs: number = MCP_READY_GATE_BUDGET_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(budget)
      unsubscribe()
      resolve()
    }
    const unsubscribe = host.onToolsListed(grantKey, settle)
    const budget = setTimeout(() => {
      createLogger('sessionpage').warn(
        { sessionId, budgetMs },
        'gugu MCP tools/list did not arrive within the startup budget; opening the startup gate anyway',
      )
      settle()
    }, budgetMs)
  })
}
