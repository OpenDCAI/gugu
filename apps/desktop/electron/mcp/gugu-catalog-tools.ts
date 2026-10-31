// catalog_* —— 咕咕 MCP 的渐进披露。原生 tools/list 按角色列固定集合,其余经 catalog_* 取用。
// 同角色的清单不随 grant 或目录内容变,复用模型前缀。目录来源由 CatalogSource 现取。

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  Tool,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { join } from 'node:path'
import { z } from 'zod'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { advertisedTool } from './gugu-im-server.mjs'
import { bestKeywordMatches } from '../../src/session/shared/extensions/query-score'
import { firstSentence } from './first-sentence'
import { listWindowShape, windowList } from './list-window.mjs'
import { assertMcpToolDescriptionWithinBudget } from './mcp-tool-description-budget.mjs'

/**
 * 原生列出的工具。投递信封、平台提示词、会话自述块、身份块里点名的必须在这里;其余按真实用量挑
 * 多数会话都会用到的(#6614 的读数)。不在这里的已注册工具只进目录,按原名 tools/call 仍然能调。
 */
export const GUGU_LISTED_TOOLS: ReadonlySet<string> = new Set([
  'message_send', 'message_send_as_owner', 'message_send_file_as_owner', 'message_send_file', 'message_history', 'message_search', 'message_members',
  'message_conversations', 'message_rules', 'message_invite', 'contact_friend', 'owner_friends_list',
  'topic_open', 'topic_list', 'profile_whoami',
  'session_message', 'session_spawn', 'session_open_in_tab', 'session_get', 'session_peers', 'session_children',
  // Native device inspection/execution. The coordinator role does not register device_call;
  // executors keep it. This set only selects from tools that their server actually registered.
  'device_actions', 'device_call',
  // #7221 「明早 8 点提醒我」:答应了以后的事,得在当场就找得到这把工具 —— 藏进目录,agent 会改用自己 harness 的定时器,
  // 进程一停就没了。看与取消不常用,留在目录。
  'schedule_create',
  // app_create / app_install 曾因 L5 S1(做 App 的路上 2 次调用花在 catalog_list + catalog_describe)列在这里;#7335 退回目录:
  // 两个合计约 900 token 每个会话都付,做 App 的会话很少(d22 三周 0 次调用),那 2 次调用只在做 App 时才花。
  'guide_topics', 'guide_read',
  'catalog_list', 'catalog_describe', 'catalog_call',
])

/** The coordinator's core tools replace occasional contact/group creation within the same budget. */
export const GUGU_ASSISTANT_LISTED_TOOLS: ReadonlySet<string> = new Set([
  ...[...GUGU_LISTED_TOOLS].filter(name => !['device_call', 'contact_friend', 'message_invite', 'topic_open'].includes(name)),
  'activity_list', 'activity_context', 'session_stop',
])

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** 目录里的一项。`name` 只是查找键,怎么执行归 `run`:别的来源(扩展)带着自己的路由接进来。 */
export interface CatalogTool {
  name: string
  description: string
  inputSchema: Tool['inputSchema']
  annotations?: ToolAnnotations
  /** false:会话自己的工具列表里已经有它,不带 name 的 catalog_list 不列;带 name 时照列、行上标 native;按名 describe / call 仍然找得到(harness 改写或藏起原生名时的兜底)。 */
  listed?: false
  run(args: unknown, extra: Extra): Promise<CallToolResult>
}

/**
 * The catalog's tools from elsewhere than this server (the installed Apps'). With `name`, only that tool is wanted: a source
 * skips what cannot hold it, so a lookup never waits on a program that does not give the name (10-19: every catalog call
 * waited on one App's program that never started).
 */
export type CatalogSource = (name?: string) => CatalogTool[] | Promise<CatalogTool[]>
/** The Agent Skills of the Apps whose tools the catalog holds (#6387): listed with them, so an App installed after the session opened brings its skill the way it brings its tools. */
export type CatalogSkills = () => ExtensionSkill[] | Promise<ExtensionSkill[]>
/** #6634 问题 16 What the catalog leaves out right now and why, one line each; read after the source, when a name is missing. */
export type CatalogLeftOut = () => string[] | Promise<string[]>

/**
 * 这台 server 上注册了、但没列出来的工具。执行走它注册时的那个回调、先过它注册时的 schema ——
 * 与 SDK 处理原生 tools/call 是同一段代码,grant、toolScope、分叉拒绝也就是同一套。
 */
export function unlistedTools(server: McpServer, listedTools = GUGU_LISTED_TOOLS): CatalogTool[] {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools
  return Object.entries(registered)
    .filter(([name]) => !listedTools.has(name))
    .map(([name, tool]) => ({
      ...(advertisedTool(name, tool) as Pick<Tool, 'name' | 'description' | 'inputSchema'> & { description: string }),
      run: async (args, extra) => {
        const schema = tool.inputSchema as z.ZodType
        const parsed = await schema.safeParseAsync(args)
        if (!parsed.success) {
          const detail = parsed.error.issues.map((issue) =>
            selfNamedArgumentHint(args, issue.path) ?? `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ).join('; ')
          return { content: [{ type: 'text', text: `Input validation error: Invalid arguments for tool ${name}: ${detail}` }], isError: true }
        }
        return (tool.handler as (args: unknown, extra: Extra) => Promise<CallToolResult>)(parsed.data, extra)
      },
    }))
}

/** #7509:只解释校验失败的同名标量包装,不改参数、不重试。合法的对象参数照常通过。 */
function selfNamedArgumentHint(args: unknown, path: PropertyKey[]): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const key = path[0]
  if (path.length !== 1 || typeof key !== 'string') return null
  const value = (args as Record<string, unknown>)[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const inner = value as Record<string, unknown>
  if (Object.keys(inner).length !== 1 || !Object.hasOwn(inner, key)) return null
  if (inner[key] !== null && typeof inner[key] === 'object') return null
  return `${key} 多套了一层同名对象：应写成 ${JSON.stringify({ [key]: inner[key] })}，不要写 ${JSON.stringify({ [key]: value })}`
}

/**
 * 咕咕自己原生列出的工具(catalog_* 本身除外),只给按关键词搜的 catalog_list 用:行上标 native,describe / call 照旧不收。
 * #7317 实测:让 agent「用我的电脑计算器按 6+6+6+6+6」,它在目录里搜 computer、screen、mouse、mac,一次也没碰到
 * 早就在它工具列表里的 device_actions,于是自己写 osascript、或把浏览器的鼠标当成电脑控制。
 */
function ownListedTools(server: McpServer, listedTools: ReadonlySet<string>): Array<{ name: string; description: string; inputSchema: Tool['inputSchema'] }> {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools
  return Object.entries(registered)
    .filter(([name]) => listedTools.has(name) && !name.startsWith('catalog_'))
    .map(([name, tool]) => advertisedTool(name, tool) as { name: string; description: string; inputSchema: Tool['inputSchema'] })
}

// #7335 目录按关键词搜:名字子串搜不到「create app」「创建 App」这类问法(实测 0 条),而 app_* 已退回目录。
// 词拆开、不分大小写,在工具名 + 完整描述(App 的 skill:名字 + App id + 描述)里找;只回命中词数最多的那一档,
// 所以 "send a file" 不会因为一个 a 把整个目录带出来;按完整工具名查,命中的仍是那一个工具。
// 10-19 打分规则挪进 shared(query-score.ts),中文按最长一段记分 —— app_search 与 App 页的搜索用同一份。
const CATALOG_SEARCH_DESCRIPTION = 'Keywords, matched in tool names and descriptions; the best matches come back.'

// 「名字从哪来」只在 catalog_call 上写一次(P5);catalog_describe 的说明本来就指着 catalog_list。
const TOOL_NAME_DESCRIPTION = 'As catalog_list prints it.'
const toolNameSchema = z.string().min(1)
// harness 的 XML/JSON 桥常把对象参数序列化成字符串,在 schema 边界收下这种形状(同 to_user_ids)。
const toolArgsSchema = z.preprocess(
  (value) => (typeof value === 'string' ? JSON.parse(value) : value),
  z.record(z.string(), z.unknown()).optional(),
).describe('As catalog_describe shows.')

const CATALOG_DESCRIPTIONS = {
  // Both halves of what the catalog holds (D-04 咕咕's less-used tools, D-02 / D-10 the installed Apps'): see product-platform-prompt.ts.
  catalog_list: 'Tools not in your tool list (less-used 咕咕 tools, installed Apps\'), one line each: call signature (? = optional) and what it does. A skill line names a SKILL.md to read when your task matches.',
  catalog_describe: 'One catalog tool\'s full definition.',
  catalog_call: 'Run a catalog_list tool by name, with the same checks and results as a listed one.',
} as const

const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
/**
 * A short enum as a row writes it (`crawl|map`): up to 4 values, 30 characters in all, none holding a character the
 * row's own syntax uses. 全能搜索 A/B 10-19: with only `mode?` an agent guessed `text` first, every time.
 */
const shortEnum = (property: unknown): string | null => {
  const values = (property as { enum?: unknown } | undefined)?.enum
  if (!Array.isArray(values) || values.length === 0 || values.length > 4) return null
  if (!values.every((value) => typeof value === 'string' && value && !/[|,)\s]/.test(value))) return null
  const written = values.join('|')
  return written.length <= 30 ? written : null
}

/**
 * A row's parameters, required ones first: `app_check(tab_kind, item_id?, chat_id?)`, a short enum written out
 * (`mode?: crawl|map`). L5 S1 rerun: two of 29 calls were catalog_describe, made only to learn the argument names before catalog_call.
 */
const callOf = (name: string, schema: Tool['inputSchema']): string => {
  const required = new Set(schema.required ?? [])
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const keys = Object.keys(properties)
  const param = (key: string, optional: boolean) => {
    const values = shortEnum(properties[key])
    return `${key}${optional ? '?' : ''}${values ? `: ${values}` : ''}`
  }
  const params = [...keys.filter((key) => required.has(key)).map((key) => param(key, false)), ...keys.filter((key) => !required.has(key)).map((key) => param(key, true))]
  return `${name}(${params.join(', ')})`
}

export function registerGuguCatalogTools(server: McpServer, source: CatalogSource, leftOut?: CatalogLeftOut, skills?: CatalogSkills, listedTools = GUGU_LISTED_TOOLS): void {
  for (const [name, description] of Object.entries(CATALOG_DESCRIPTIONS)) assertMcpToolDescriptionWithinBudget(name, description)
  const find = async (name: string): Promise<CatalogTool> => {
    const entry = unlistedTools(server, listedTools).find((tool) => tool.name === name) ?? (await source(name)).find((tool) => tool.name === name)
    // #6634 问题 14 W-21: Claude, having installed through catalog_call, sent catalog_list and catalog_call through it too.
    if (!entry && listedTools.has(name)) throw new Error(`${name} is one of your own tools, not a catalog entry: call it directly`)
    if (!entry) {
      // #6634 问题 16 W-21: a program whose tools/list failed was simply absent; the agent guessed names for minutes.
      // An extension the person revoked or turned off was absent the same way, and an agent went and ran its program by hand.
      const missing = leftOut ? await leftOut() : []
      throw new Error(`no tool named ${name} in the catalog; catalog_list shows what is there`
        + (missing.length > 0 ? `. Left out of the catalog right now: ${missing.join('; ')}` : ''))
    }
    return entry
  }
  server.registerTool(
    'catalog_list',
    { description: CATALOG_DESCRIPTIONS.catalog_list, inputSchema: z.object({ ...listWindowShape, name: z.string().optional().describe(CATALOG_SEARCH_DESCRIPTION) }).strict() },
    async (args) => {
      // A row is `{ call, about }`: `call` already starts with the name (上下文工程第一批 P6 dropped the `name` copy, −11% per listing).
      // A name search also finds the tools already in the session's own list: an agent that looked an App up by name, got nothing and hand-wrote its files (小修汇总 3).
      const searched = Boolean(args.name?.trim())
      // An App's skill comes before the tools: what to read before calling them (an App given after the session opened).
      const skillEntries = (skills ? await skills() : []).map((skill) => ({
        row: { skill: skill.name, app: skill.extensionId, about: firstSentence(skill.description), read: join(skill.dir, 'SKILL.md') },
        text: `${skill.name} ${skill.extensionId} ${skill.description}`,
      }))
      const toolEntries = [...unlistedTools(server, listedTools), ...await source()].filter((tool) => searched || tool.listed !== false).map((tool) => ({
        row: { call: callOf(tool.name, tool.inputSchema), about: firstSentence(tool.description), ...(tool.listed === false ? { native: true } : {}) },
        text: `${tool.name} ${tool.description}`,
      }))
      // …and so do 咕咕's own listed tools (#7317).
      const ownEntries = (searched ? ownListedTools(server, listedTools) : []).map((tool) => ({
        row: { call: callOf(tool.name, tool.inputSchema), about: firstSentence(tool.description), native: true as const },
        text: `${tool.name} ${tool.description}`,
      }))
      type Row = (typeof skillEntries)[number]['row'] | (typeof toolEntries)[number]['row']
      const rows = bestKeywordMatches<Row>([...skillEntries, ...toolEntries, ...ownEntries], args.name)
      return text(windowList(rows, { ...args, name: undefined }, { namesOf: () => [], catalog: true }))
    },
  )
  server.registerTool(
    'catalog_describe',
    { description: CATALOG_DESCRIPTIONS.catalog_describe, inputSchema: z.object({ tool: toolNameSchema }).strict() },
    async ({ tool }) => {
      const { name, description, inputSchema, annotations } = await find(tool)
      return text({ name, description, inputSchema, annotations })
    },
  )
  server.registerTool(
    'catalog_call',
    { description: CATALOG_DESCRIPTIONS.catalog_call, inputSchema: z.object({ tool: toolNameSchema.describe(TOOL_NAME_DESCRIPTION), args: toolArgsSchema }).strict() },
    async ({ tool, args }, extra) => {
      const entry = await find(tool)
      // Claude, fresh from a skill's `catalog_call({ tool, args: { … } })` example, put the arguments in a second `args`
      // (once with `tool` beside it): the program then answered about a field it was missing, not about the wrapping.
      const inner = args?.args
      if (inner && typeof inner === 'object' && !Object.hasOwn(entry.inputSchema.properties ?? {}, 'args')) {
        return { content: [{ type: 'text', text: `${tool}'s arguments came wrapped in a second args: put them straight in args — catalog_call({ tool: "${tool}", args: { … } })` }], isError: true }
      }
      return entry.run(args ?? {}, extra)
    },
  )
}
