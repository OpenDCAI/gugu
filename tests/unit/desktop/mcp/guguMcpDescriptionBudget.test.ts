import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
import { EXTENSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { registerSessionpageTools } from '../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import {
  CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET,
  assertMcpToolDescriptionWithinBudget,
} from '../../../../apps/desktop/electron/mcp/mcp-tool-description-budget.mjs'

// @@@mcp-description-budget — Claude Code 把每个 MCP 工具的顶层描述截到 2048 字符再交给模型。
// #4191 原子化后工具面 = 三份 DEF 清单(社交域 TOOL_DEFS + session 域 + extension 域),注册时逐条
// 把 def.description 原样交给 registerTool,所以在 DEF 层枚举 == 在 tools/list 层枚举。
// 超预算的工具在 Claude Code 里尾巴静默消失,是 loss。(形状取自 #6074 那一版。)
describe('gugu MCP tool descriptions stay within the Claude Code budget', () => {
  const allDefs = [
    ...(TOOL_DEFS as Array<{ name: string; description: string }>),
    ...SESSION_TOOL_DEFS,
    ...EXTENSION_TOOL_DEFS,
  ]

  it('every atomic tool across all three domains fits the budget', () => {
    const readings = allDefs.map((def) => ({ name: def.name, chars: def.description.length }))
    process.stdout.write(`[mcp-description-budget] ${JSON.stringify(readings)}\n`)
    // 23(社交:30 + #6492 的 group_list / group_add_agent − 并入 message_send 的 message_reply + #6698 的 group_update + 工作区 App 的 workspace_edit / workspace_rename − 退役的整篇写回 workspace_update_document − 搬进群文件夹 App 的 workspace_* 十个)+ 11(session:owner 09-30 跨机器加 session_devices;10-02 加 session_set_parent;task → session 去掉列 task 的那个工具)+ 5(extension:#6614 extension_guide 并入 guide_read;#6646 加 app_pack;#6612 加的静态校验工具已按主人 09-28 删掉;F5 加 app_check —— 它读的是跑起来的 App,不是那种静态校验)= 39;+ 2(#7199 第二步:device_actions / device_call,云端助理调用户设备上的单个动作)= 41。
    // #7299 adds message_send_as_owner and message_send_file_as_owner.
    // #7471 adds catalog-only group_create.
    // 10-19 app_list moved into app_search; #7520 adds the catalog-only session_ask_user.
    // 论坛 (10-20) adds the catalog-only forum_reply and forum_read.
    expect(readings).toHaveLength(46)
    const over = readings.filter(({ chars }) => chars > CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET)
    expect(over, `${readings.length - over.length} of ${readings.length} tools fit ${CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET} chars`).toEqual([])
  })

  // 反例对照:判据的存在 ≠ 判据能判假 —— 构造一条超预算描述,证明这道闸真的会红。
  it('an over-budget description throws at the shared assert (and exactly-at-budget does not)', () => {
    expect(() => assertMcpToolDescriptionWithinBudget('over_budget_probe', 'x'.repeat(CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET + 1)))
      .toThrow(/over_budget_probe.*2049.*truncates/s)
    expect(() => assertMcpToolDescriptionWithinBudget('at_budget_probe', 'x'.repeat(CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET)))
      .not.toThrow()
  })

  // 注册路径上的同一道闸:registerSessionpageTools 在注册第一刻就抛,而不是等 tools/list。
  it('registering an over-budget tool def fails loud before it reaches the server', () => {
    const server = new McpServer({ name: 'budget-probe', version: '0.0.0' })
    expect(() => registerSessionpageTools(
      server,
      [{
        name: 'session_budget_probe',
        description: 'y'.repeat(CLAUDE_CODE_MCP_TOOL_DESCRIPTION_BUDGET + 1),
        schema: z.object({}).strict(),
        action: 'budget_probe',
      }],
      undefined,
      (tool) => `${tool} is unavailable`,
      (work) => work,
    )).toThrow(/session_budget_probe.*truncates/s)
  })
})
