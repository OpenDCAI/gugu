// schedule_* 域(#7221)—— agent 在它自己所在的那台机器上给**自己**排「已安排」:到点咕咕把它写下的交代原样送回
// 这条会话(同一身份、同一段对话),所以「明早 8 点提醒我」的结果落在用户原来那条聊天里。
// 看与取消可带 session_id 指名主人的另一条会话(与 session_archive 同一个口径:同一个账号、任一台机器)。
// 动作交给会话分派器(与 session_* 同一个,session-orchestration.ts → automations/agent-schedules.ts);
// 注册机制在 sessionpage-tool-registrar.ts。

import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listWindowShape } from './list-window.mjs'
import {
  registerSessionpageTools,
  type SessionDispatcher,
  type SessionpageToolDef,
} from './sessionpage-tool-registrar'

const SESSION_ID_DESCRIPTION = 'session:<id> of the session that set it; omit for yourself.'

export const SCHEDULE_TOOL_DEFS: readonly SessionpageToolDef[] = [
  {
    name: 'schedule_create',
    description: 'Persist a prompt for this session: once (at) or recurring (cron), surviving process/device shutdown. Use this instead of harness timers or sleep loops. Shown in 已安排; verify next_run_at.',
    schema: z.object({
      prompt: z.string().min(1).describe('A standalone instruction to your future self, saying where the result goes.'),
      at: z.string().min(1).describe('ISO 8601; at or cron, not both.').optional(),
      cron: z.string().min(1).optional(),
      tz: z.string().min(1).describe('IANA zone for at / cron; default: this machine\'s.').optional(),
      title: z.string().min(1).optional(),
    }).strict(),
    action: 'schedule_create',
  },
  {
    name: 'schedule_list',
    description: 'List the schedules you set with schedule_create, or with session_id those another session of yours set, on whichever of your machines it runs: each one\'s schedule_id, title, prompt, when (at, or cron with tz), whether it is still active, next_run_at and its last run. A one-time schedule turns inactive once it has run; the person may also have paused or deleted one in the 已安排 list.',
    schema: z.object({
      session_id: z.string().min(1).describe(SESSION_ID_DESCRIPTION).optional(),
      ...listWindowShape,
    }).strict(),
    action: 'schedule_list',
    list: { key: 'schedules', namesOf: (row) => [row.title] },
  },
  {
    name: 'schedule_cancel',
    description: 'Cancel a schedule: it is deleted and does not fire again. Yours by default; with session_id, one that another session of yours set (archived ones included), on whichever of your machines it runs. Sessions of other accounts are out of reach.',
    schema: z.object({
      schedule_id: z.string().min(1).describe('schedule:<id>, exactly as schedule_create or schedule_list returned it.'),
      session_id: z.string().min(1).describe(SESSION_ID_DESCRIPTION).optional(),
    }).strict(),
    action: 'schedule_cancel',
  },
]

/** 把 schedule_* 注册进已有 MCP server,动作交给宿主的会话分派器(与 session_* 同一个)。 */
export function registerGuguScheduleTools(
  server: McpServer,
  runAction: SessionDispatcher | undefined,
  track: GuguMcpRequestTracker,
): void {
  registerSessionpageTools(server, SCHEDULE_TOOL_DEFS, runAction, (tool) => `${tool} is unavailable for this grant`, track)
}
