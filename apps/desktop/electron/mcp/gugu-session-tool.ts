import { parseConversationLink } from '@gugu/core/shared/ui/guguLink'
// session_* 域 —— 会话页会话管理的十个原子工具(发现 harness/model、列任务、起子会话、读、停、归档、开 tab)。
// 与社交域、extension 域注册在同一个会话 MCP server 上;是否注册只取决于这条 grant 是否属于
// 会话页会话。单 server 下「域」是架构一等公民(#4191):本文件只有这个域的定义,注册机制在
// sessionpage-tool-registrar.ts,extension 域在 gugu-extension-tool.ts。
//
// #4191:每个 action 一个原子工具(回归 2fb81f0541 的原子形态),域靠名字前缀分组。原先的胖工具
// `gugu_session`(action 参数 + union 摊平 + 变体挑选报错)整套退役;每个工具的描述就是该动作的
// 完整用法,独享一份顶层描述预算。

import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { assertWorkReportArgument, workReportSchema } from '../../src/session/shared/assistant-work'
import { SESSION_MESSAGE_REPLY_TO, SESSION_MESSAGE_THEN } from '@gugu/core/local/agent/deliveryEnvelope'
import {
  registerSessionpageTools,
  type SessionDispatcher,
  type SessionpageListSpec,
  type SessionpageToolDef,
} from './sessionpage-tool-registrar'
import {
  agentStatusFilterSchema,
  listWindowShape,
  matchesAgentStatus,
  pinnedFilterSchema,
} from './list-window.mjs'

export type { SessionDispatcher } from './sessionpage-tool-registrar'

export type SessionTransport = 'acp' | 'pty'

// 参数从哪来只在一处写(上下文工程第一批 P5):session_id 在 session_get 上,device 在 session_spawn 上。
const SESSION_ID_DESCRIPTION = 'session:<id>.'
const sessionIdSchema = z.string().min(1)
const arrayArgument = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

/** agent 的 session_* 跨机器(owner 2026-09-30 拍板):「在哪台机器上做」—— 只给还没有地址的动作;有地址的会话自己带路。 */
const DEVICE_DESCRIPTION = 'device:<id> from session_devices; omit for this machine.'
const deviceSchema = z.string().min(1)
const sourceLinkSchema = z.string().trim().refine((value) => !!parseConversationLink(value)?.messageId, 'source_link requires gugu-chat://chatUUID/messageUUID').describe('Original source_link from delivery.')

/** 置顶筛选:行上的 `pinned` 是本机任务库那一列(侧栏读的同一格)。 */
const keepPinned = (row: Record<string, unknown>, args: Record<string, unknown>) =>
  args.pinned === undefined || row.pinned === args.pinned

/**
 * session_children 的行。近况(MessagePreview + 最后一轮怎么收的)只给返回的这一页算：每行走 session_get 那个动作 ——
 * 宿主唯一的入口 readSessionPreview 在它后面;别的机器上的行由宿主转给那台去算。归档的不算。
 * 一行读不到就把原因放在这一行，❌ 让整张列表失败。
 */
const SESSION_ROWS: SessionpageListSpec = {
  namesOf: (row) => [row.title],
  filterKeys: ['status', 'pinned'],
  statusFilter: true,
  keep: (row, args) =>
    (row.status !== 'archived' || args.status === 'archived')
    && matchesAgentStatus(row as { status?: string | null; detail?: string | null }, args.status as string | undefined)
    && keepPinned(row, args),
  eachItem: async (row, call) => {
    if (row.status === 'archived') return row
    try {
      return { ...row, preview: ((await call({ action: 'get', session_id: row.session_id })) as { preview?: unknown }).preview }
    } catch (error) {
      return { ...row, preview: { error: { code: 'preview_failed', message: error instanceof Error ? error.message : String(error) } } }
    }
  },
}

export const SESSION_TOOL_DEFS: readonly SessionpageToolDef[] = [
  {
    name: 'session_devices',
    description: 'List your devices, including phones without a task host, with online status, last seen time and task_runtime (capability and installed runtimes). Task hosting is separate from device_actions native-data grants. Your cloud computer carries cloud_computer (asleep, waking or awake): asleep is not offline, and passing it as device wakes it first. Pass a device_id as device to session_spawn, session_peers, session_list_harnesses or session_list_models to work on that machine.',
    schema: z.object({ ...listWindowShape }).strict(),
    action: 'devices',
    list: { namesOf: (row) => [row.label], catalog: true },
  },
  {
    name: 'device_actions',
    description: 'Inspect native actions; Computer Use: control macOS/Windows desktop apps (screen, mouse, keys; computer); no scripts/bypass. Omit device: devices/status/timezone/groups. With device: actions; group/name: read schema first. Other-device work: session_spawn there. available:false has unavailable_detail.',
    schema: z.object({
      device: deviceSchema.describe('Omit for all devices.').optional(),
      group: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    }).strict(),
    action: 'device_actions',
  },
  {
    name: 'device_call',
    description: 'Run one listed action on your host; elsewhere session_spawn (enable its host first). Returns ok/data or ok:false/code/message. no_answer may have run. not_granted/os_permission: explain enablement. needs_confirmation: ask confirm.question; only after agreement retry confirmed:true. Unzoned times use device timezone.',
    schema: z.object({
      device: deviceSchema,
      name: z.string().min(1).describe('As device_actions lists it.'),
      args: z.record(z.string(), z.unknown()).describe('Per its input_schema.').optional(),
      timeout_ms: z.number().int().min(1000).max(300000).describe('Default 30000.').optional(),
    }).strict(),
    action: 'device_call',
  },
  {
    name: 'session_list_harnesses',
    description: 'List the harnesses a machine offers for starting a Gugu session agent — this one, or another of yours with device — the same list a person sees in the session-page engine picker, no wider. Each item is a canonical harness id for session_spawn, its session-page shapes, installation status, and whether it is spawnable; blocked names each shape that cannot start here and why, in the words session_spawn refuses with. current_harness is the one running this session; spawn_default_harness is the one session_spawn uses when you omit harness. It never exposes executable paths or credentials.',
    schema: z.object({ device: deviceSchema.optional(), ...listWindowShape }).strict(),
    action: 'list_harnesses',
    list: { key: 'harnesses', namesOf: (row) => [row.id, row.name], catalog: true },
  },
  {
    name: 'session_list_models',
    description: 'List the models a session agent can be started on — the same two groups a person sees in the session-page model dropdown. Every entry\'s id is ready to pass straight to session_spawn as `model`, and says whose quota it spends: source "gugu" is a Gugu-provided model billed to Gugu credits (its id carries a `platform:` prefix), source "harness" is one of the harness\'s own models on your own account/key. An unavailable or unauthenticated harness returns no fabricated models, and an absent Gugu group comes back with the product\'s own reason for it.',
    schema: z.object({
      harness: z.string().describe('Canonical harness id from session_list_harnesses. Omit it (or pass an empty string) to inspect the harness running this session.').optional(),
      transport: z.enum(['acp', 'pty']).describe('The shape the child would run as, because the Gugu-provided group is decided per harness AND per shape. Omit it to ask about this session\'s own shape — the same default session_spawn uses, so an omitted transport here matches an omitted transport there.').optional(),
      force: z.boolean().describe('Refresh the harness ACP model probe instead of using a fresh cached catalog.').optional(),
      device: deviceSchema.optional(),
      ...listWindowShape,
    }).strict(),
    action: 'list_models',
    list: { key: 'models', namesOf: (row) => [row.id, row.name], catalog: true },
  },
  {
    name: 'session_spawn',
    description: 'Start a persistent Gugu agent; returns session_id and model. Omit transport to inherit your chat or terminal UI.',
    schema: z.object({
      prompt: z.string().min(1),
      source_link: sourceLinkSchema.optional(),
      title: z.string().min(1).describe('Short name; default automatic.').optional(),
      device: deviceSchema.describe(DEVICE_DESCRIPTION).optional(),
      // #7331 先复用:描述只说「新目录当场登记」时,agent 把每个自己切的 worktree 都传进来,对方机器上一个 worktree 一个项目。
      project: z.string().min(1).describe('Existing project:<id> or root. New projects only when requested; subfolders/worktrees go in prompt. Omit: current directory (remote: home).').optional(),
      nest: z.boolean().describe('Child reporting to you, listed in session_children. Default true without project.').optional(),
      transport: z.enum(['acp', 'pty']).optional(),
      harness: z.string().describe('From session_list_harnesses; default: your sub-agent default.').optional(),
      model: z.string().describe('From session_list_models (verbatim) or model.spawn_model_id; platform: ids bill Gugu credits.').optional(),
      chat_id: z.string().min(1).describe('A group your owner is in, for the child to join.').optional(),
    }).strict(),
    action: 'spawn',
  },
  {
    name: 'session_ask_user',
    description: 'Show the owner a compact question card. Returns pending immediately; its explicit answer arrives as a new delivery, so continue other work. Pending or withdrawn is never consent. Task agents first ask their supervising assistant via session_message.',
    schema: z.object({
      questions: z.array(z.object({
        question: z.string().trim().min(1),
        header: z.string().optional(),
        options: z.array(z.object({ label: z.string().trim().min(1), description: z.string().optional() }).strict()).min(2).max(5),
        multi_select: z.boolean().optional(),
      }).strict()).min(1).max(3),
      source_link: sourceLinkSchema.optional(),
    }).strict(),
    action: 'ask_user',
  },
  {
    name: 'session_children',
    description: 'Direct children, newest first (default: yours). Archived only with status:"archived"; preview.ended = last turn\'s end.',
    schema: z.object({
      session_id: sessionIdSchema.optional(),
      ...listWindowShape,
      status: agentStatusFilterSchema,
      pinned: pinnedFilterSchema,
    }).strict(),
    action: 'children',
    list: SESSION_ROWS,
  },
  {
    name: 'session_message',
    description: 'Message sessions across devices: session:<id>, aid:<Agent ID>, gugu:<number> from session_peers. Resumes stopped recipients; reports delivery. Owner sees task exchanges. Chat members: message_send.',
    schema: z.strictObject({
      // ACP XML/JSON bridges sometimes serialize array parameters as JSON strings。协议边界兼容是
      // im-mcp spec 的既有合同(「合法的 JSON 序列化数组继续在协议边界兼容,裸字符串或非法 JSON
      // 不被猜成数组」)。
      // ⚠️ 机制是**新落点没继承**,不是「被删」:im 域的 toUserIdsSchema 仍在
      // (gugu-im-server.mjs,继续服务 chat 的 to_user_ids),但本机直投搬到了 session 域这个
      // 工具的 to 上,而它当初写成裸 z.array —— 合同没跟过来。这里补上。
      to: z.preprocess(
        (value) => {
          if (typeof value !== 'string') return value
          const trimmed = value.trim()
          if (!trimmed.startsWith('[')) return value
          try { return JSON.parse(trimmed) } catch { return value }
        },
        z.array(
          z.string().min(1).refine(
            (value) =>
              value.startsWith('session:')
              || value.startsWith('aid:')
              || value.startsWith('user:')
              || value.startsWith('gugu:'),
            { message: 'each to entry must be a typed address — "session:<id>" (a typed session id from session_spawn / session_children / session_get), "aid:<Agent ID>" (the Agent ID shown on a session\u2019s share card, listed by session_peers; the older spelling "user:<uuid>" is still accepted) or "gugu:<number>" (a 咕咕号 from session_peers); bare ids, bare numbers and other id types are rejected' },
          ),
        ).min(1),
      // 集体记忆对账第 2 条：本机按项目设的闸 09-30 拆了，session: 够得着这个账号任何一台机器上的会话（跨机器
      // DESIGN.md:23；session-orchestration.ts 的 session: 解析、main.ts 的跨机器转发）。与上面的总说明同一个意思。
      // 地址写法顶层描述已列,拒绝时 refine 的原话再说一遍 —— 字段上不重复(#7335 预算)。
      ),
      text: z.string().min(1),
      work_id: z.string().uuid().optional(),
      work_result: workReportSchema.optional().describe('Delegated execution report. Fill this argument, not text. completed/cancelled closes only the matching executor wait; progress/question does not.'),
      files: z.preprocess(arrayArgument, z.array(z.object({ file_path: z.string().min(1), file_name: z.string().optional(), mime_type: z.string().optional() }).strict()).min(1).max(8)).optional(),
      source_link: sourceLinkSchema.optional(),
      // owner 10-17:发信方自己说发完以后去向,收件方在信封上读到(then="…")。是协议,不是程序推出的状态。
      then: z.enum(SESSION_MESSAGE_THEN).describe('What you do next: continue, wait (on what: say) or stop.').optional(),
      // 与 message_send 同名;取值是收到的那条信封的 msg。只核写法(与编排层同一个 regex),不查存在(发信方的话)。
      // refine 不进 JSON schema:不多花工具描述预算。
      reply_to_message_id: z.string().refine((value) => SESSION_MESSAGE_REPLY_TO.test(value), 'reply_to_message_id must be a msg:<uuid> as a delivery\'s msg gives it').optional(),
    }, {
      // #4562 破坏要响:旧的单数 session_id 入参被明确拒绝并说清新形状,❌ 不悄悄猜成 to:[x]。
      error: (issue) => issue.code === 'unrecognized_keys'
        ? ((issue as { keys?: string[] }).keys?.includes('session_id')
            ? 'session_message no longer takes session_id — pass to: an array of typed addresses, e.g. {to:["session:<id>"], text:"..."}, {to:["aid:<Agent ID>"], text:"..."} or {to:["gugu:<number>"], text:"..."}'
            : undefined)
        : undefined,
    }).superRefine((value, ctx) => {
      try { assertWorkReportArgument(value) }
      catch (error) { ctx.addIssue({ code: 'custom', path: ['work_result'], message: (error as Error).message }) }
    }),
    action: 'message',
  },
  {
    name: 'session_open_in_tab',
    description: 'Open a file (path), page (url) or installed App tab (app_tab; with path, that App opens the file) in your session\'s pane. Notifies no one.',
    schema: z.object({
      path: z.string().min(1).describe('Relative to your code directory, or absolute (read-only outside it).').optional(),
      url: z.string().min(1).optional(),
      app_tab: z.string().min(1).describe('A tab_kind as app_search / app_install returned it.').optional(),
      // 工具面把它广告成可选,这里就必须真的可选。两处对不上时,照广告发的调用被硬拒,而
      // agent 从拒绝信息里读出的结论是「这个工具没有 open_in_tab」——#4090 交付后第一份真实
      // 使用报告就是这么误诊的(#4189)。默认 pinned:描述里承诺「the tab is the signal」,而 preview
      // 槽会被下一次打开顶掉,信号就没了。
      intent: z.enum(['preview', 'pinned']).default('pinned').describe('pinned (default) keeps the tab; preview reuses one slot.'),
    }).strict().superRefine((value, ctx) => {
      // 摩擦单 F122: path with app_tab is「open with X」— the one pair; a url stands alone.
      const given = [value.path, value.url, value.app_tab].filter(Boolean).length;
      if (given === 0 || (value.url && given > 1)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'session_open_in_tab takes path (with app_tab to open it with that App), url, or app_tab',
        });
      }
    }),
    action: 'open_in_tab',
  },
  {
    name: 'session_list_tabs',
    description: 'List the live tabs in your own task, including their ids and titles. Conversation tabs cannot be closed.',
    schema: z.object({}).strict(),
    action: 'list_tabs',
  },
  {
    name: 'session_close_tab',
    description: 'Close one supplementary tab in your own task. Unsaved files keep their usual confirmation; closed:false means the tab stayed open.',
    schema: z.object({ tab_id: z.string().min(1).describe('From session_list_tabs or session_open_in_tab.') }).strict(),
    action: 'close_tab',
  },
  {
    name: 'session_get',
    description: 'Read this session (omit session_id) or another of yours: project_id, transport, status, model, preview. Pass model.spawn_model_id, not model.id, to session_spawn.',
    schema: z.object({ session_id: sessionIdSchema.describe(SESSION_ID_DESCRIPTION).optional() }).strict(),
    action: 'get',
  },
  {
    name: 'session_stop',
    description: 'Stop another session of yours, whoever spawned it: it stops what it is doing and its process exits. It keeps its identity and history, and the next message resumes it; session_archive puts it away.',
    schema: z.object({ session_id: sessionIdSchema }).strict(),
    action: 'stop',
  },
  {
    name: 'session_archive',
    description: 'Archive another session of yours: stop its process, remove its agent identity and hide it from lists. A person can restore it from history. session_get still reads it; session_children requires status:"archived". with_children=true archives its subtree; default false archives only this one. Only a person can delete a session.',
    schema: z.object({
      session_id: sessionIdSchema,
      with_children: z.boolean().describe('Also archive every session under it (its children, transitively, on any of your machines) — the "together with its child sessions" box on the session page. Machines that could not be reached are listed in not_reached.').optional(),
    }).strict(),
    action: 'archive',
  },
  {
    name: 'session_set_parent',
    description: 'Change which session a session of yours is listed under — the parent in the session list and in session_children, on any of your machines; who spawned it stays as it was (spawned_by_session_id, provenance only). Use it to put a session under you (or under any other session) as a child, or to take one out from under its parent as a root of its own (parent_session_id null). A parent cannot end up under its own child.',
    schema: z.object({
      session_id: sessionIdSchema,
      parent_session_id: sessionIdSchema.nullable().describe('The session to list it under, as session:<id>; null makes it a root session.'),
    }).strict(),
    action: 'set_parent',
  },
]

/**
 * 把 session_* 原子工具注册进已有 MCP server，动作交给宿主的会话分派器。
 *
 * F54: keep fixed definitions within each role. The coordinator omits device_call;
 * executors retain it, including those in the assistant's workspace. These are two
 * fixed surfaces, not per-session variants; assistants share their own prefix and
 * already have a different system prompt from executors. No shared settings deny.
 * 调用方自己是终端还是面板(#4378 曾写进 session_spawn 的说明)由会话的 surface 自述块说
 * (capability-bundle.ts guguSessionSurfaceBody)。
 */
export function registerGuguSessionTools(
  server: McpServer,
  runAction: SessionDispatcher | undefined,
  track: GuguMcpRequestTracker,
  personalAssistant = false,
): void {
  const defs = personalAssistant ? SESSION_TOOL_DEFS.filter(def => def.name !== 'device_call') : SESSION_TOOL_DEFS
  registerSessionpageTools(server, defs, runAction, (tool) => `${tool} is unavailable for this grant`, track)
}
