// @@@mcp-description-budget — Claude Code 把每个 MCP 工具的**顶层** description 截到 2048 字符再交给模型:
//   `var WX=2048`,`prompt(){ R.length>WX ? Wk(R,WX)+"… [truncated]" : R }`
// 三条起动路径(ACP 面板 / claude TUI / codex 分流)上真正截断的是 PATH 里的 host `claude`(2.1.241);
// 依赖树里 @anthropic-ai/claude-agent-sdk 0.3.197 自带的二进制只是兜底,常数相同。2026-08-24 用 strings 读出。
// 同一份二进制拼装模型可见文本时把各**字段**的 description 原样追加、不截(`CIp`),所以用法写在字段说明里,
// 顶层只做路由。codex 没有这道截断。
//
// 这是 Claude Code 的常数,不是我们的设计值;它变了这里跟着改。共享给 .ts 与 .mjs 两侧的工具定义,
// 所以是 .mjs(gugu-im-server.mjs 只能 import .mjs)。
export const CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET = 2048

// @@@tool-output-budget — 一次工具**输出**的字节上限(我们的设计值,由 Codex 的常数推出)。Codex 把一次工具输出按字节
// 截中间:模型元数据的 truncation_policy 缺省 `bytes(10_000)`,记入历史时再乘 1.2 = 12 000 字节(codex-rs 0.156.1
// `with_serialization_allowance`、`truncate_middle_chars`),超了就丢中段(#6615 W-22 实测一篇 20.5KB 的指南丢了 42%)。
// 代码模式下脚本常把结果再 JSON 化一遍(换行、引号转义会变长),所以留出余量,取 8 000。
// 用它的:guide_read 的每篇指南;群文件夹 App 的 read 每一页也按这个数切(folder.mjs 的 PAGE_BYTES,写进指南 apps-programs)。
export const TOOL_OUTPUT_BYTE_BUDGET = 8_000

// @@@listed-tools-budget — 原生 tools/list 列出的那组工具(GUGU_LISTED_TOOLS)整组的预算,按 estimatePromptTokens 计 tools/list
// 的 JSON。咕咕 MCP 是 alwaysLoad:Claude Code 的工具搜索不推迟它,每个会话开场全额付这笔(#7335:31 个工具 36,333 字符 ≈ 9.1k → 29 个 15.6k 字符 ≈ 3.9k)。
// 描述只写模型不知道的咕咕事实(地址、哪个工具干什么、闸、返回里要接着用的字段):通用知识、实现细节、返回字段清单、
// 别处已说过的话不写。加字前先删字,❌ 因为写不下就抬。
export const GUGU_LISTED_TOOLS_TOKEN_BUDGET = 4_000

/** 注册即抛:超预算的描述在 Claude Code 里尾巴静默消失,那比起不来更糟。 */
export function assertMcpToolDescriptionWithinBudget(name, description) {
  const length = typeof description === 'string' ? description.length : 0
  if (length > CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET) {
    throw new Error(
      `MCP tool ${name} description is ${length} chars; Claude Code truncates tool descriptions at ${CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET} — move usage detail into field descriptions`
    )
  }
}
