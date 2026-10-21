// @@@4281 咕咕注入给每个 agent 的那台 MCP server 的**声明名** —— 宿主侧的单一出处。
//
// 为什么单独一个模块:这个名字同时被四处消费(server 构造、两个 bridge 的 `AcpMcpServer.name`、
// codex 的配置键),而**四处不一致时没有任何一层会报错**。codex 那条尤其阴:配置键对不上,
// `mcpServer/tool/call` 得到 `-32603 unknown MCP server`,表现是一条永远「运行中」的 turn,
// 不是一条错误(#3551 那族「挂满」)。所以名字必须只有一个字面量。
//
// ⚠️ 插件清单(`packages/session-plugins/.../{claude,codex}/session-bundle.ts` 的 `pluginMcpConfig`)
// 是**另一侧**的独立声明,刻意不从这里 import:那是版本化静态包的审计字节,跨包边界。两侧对不上时
// `assertPackageDeclaresMcpServers()` 在 spawn 前点名 fail loud,并另有单测逐字对齐。

/** MCP server 的声明名。这是宿主交给 harness 的那个字符串。 */
export const GUGU_MCP_SERVER_NAME = 'gugu'

/**
 * codex 的**配置键** = 声明名经 codex 自己的归一(非 `[A-Za-z0-9_]` → `_`)。
 *
 * ⚠️ 声明名与配置键**不是同一个字符串**:`gugu-im` 时代它们是 `gugu-im` / `gugu_im`,按工具名
 * 反推配置键实测得到过 -32603。`gugu` 里没有需要归一的字符,于是两者当前恰好同形 —— 那是名字的
 * 巧合,❌ 不是可以依赖的规则,所以这里照样过一遍归一。
 */
export const GUGU_MCP_CONFIG_KEY = GUGU_MCP_SERVER_NAME.replace(/[^A-Za-z0-9_]/g, '_')

/**
 * 模型看到的咕咕 MCP 工具命名空间:`mcp__<配置键>`(codex-rs 0.156.1 `codex-mcp/src/tools.rs` 给 MCP 工具加
 * `mcp__` 前缀)。codex 报 MCP 工具调用时,工具名可能是声明的短名,也可能是 code mode 的全名
 * (`mcp__gugu__message_send`);在这条边界上剥掉前缀,回复工具才不会被认错。
 */
export function normalizeGuguToolName(value) {
  const name = String(value ?? '').trim()
  const prefix = `mcp__${GUGU_MCP_CONFIG_KEY}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}
