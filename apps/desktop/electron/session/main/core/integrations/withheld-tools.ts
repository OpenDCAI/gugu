import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * 集成自己声明「不交给会话」的工具(滴滴第一版:下单那几个,真实扣费)。
 * 桥仍然原样转发其余的;这里只做两件事:列表里去掉,被直接点名调用时明确拒绝、不转给对方。
 */
export function visibleTools(tools: readonly Tool[], withheld: ReadonlySet<string> | undefined): Tool[] {
  return withheld?.size ? tools.filter((tool) => !withheld.has(tool.name)) : [...tools]
}

export function withheldToolResult(name: string, withheld: ReadonlySet<string> | undefined): CallToolResult | null {
  if (!withheld?.has(name)) return null
  return { isError: true, content: [{ type: 'text', text: `${name} is not available in Gugu.` }] }
}
