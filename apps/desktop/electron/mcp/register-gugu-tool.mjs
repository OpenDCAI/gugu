// 一个咕咕工具注册进 MCP server 的那一串 —— 社交域(gugu-im-server)与会话页各域(sessionpage-tool-registrar)共用
// (App 体检 10-17 #15):顶层描述预算 → registerTool → 出错包成 isError → 交宿主计时(trackRequest:耗时与超 10 s
// 告警,grant 关闭时等它跑完)。参数怎么解码、结果怎么写成 content,是各域自己的事(`run`)。
import { z } from 'zod'
import { assertMcpToolDescriptionWithinBudget } from './mcp-tool-description-budget.mjs'

/**
 * `def.permissive`:注册时只认一个对象 —— SDK 在回调之前先按注册的 schema 校验,常见的 harness 式写错(`{to,message}`)
 * 会在那里被拒成一句 agent 看不懂的话。到这里先 `def.preflight`(给那几种写错说人话),再按真 schema 严格校验,
 * 不认识的键点名拒 —— 静默删掉更糟:agent 以为说了的话没生效(#6840)。tools/list 广告的仍是真 schema(advertisedTool)。
 */
export function registerGuguTool(server, def, run, track) {
  // @@@mcp-description-budget 顶层描述超 Claude Code 预算 ⇒ 注册即抛(尾巴静默消失比起不来更糟)。
  assertMcpToolDescriptionWithinBudget(def.name, def.description)
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.permissive ? z.record(z.unknown()) : def.schema },
    async (rawArgs, { signal }) => {
      try {
        const work = run(def.permissive ? strictArgs(def, rawArgs) : rawArgs, signal)
        return await track(work, def.name)
      } catch (error) {
        // MCP 约定：工具错误走 isError,让 agent 看得到原因并自处理。
        return { content: [{ type: 'text', text: `error: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
      }
    },
  )
}

function strictArgs(def, args) {
  def.preflight?.(args)
  const parsed = def.schema.strict().safeParse(args)
  if (parsed.success) return parsed.data
  const detail = parsed.error.issues
    .map((issue) => issue.code === 'unrecognized_keys'
      ? `不认识的参数 ${issue.keys.join('、')};合法参数:${Object.keys(def.schema.shape).join('、')}`
      : `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new Error(`Input validation error: 参数不合法 —— ${detail}`)
}
