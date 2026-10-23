// 会话页两个工具域(session_* / app_*)共用的注册机:zod 校验交给 SDK、
// typed id 双向编解码、test-only 审计、错误走 isError。域的定义各住各的文件
// (gugu-session-tool.ts / gugu-extension-tool.ts),这里只有跨域一致的机制 —— 单 server 下
// 「域」是架构一等公民(#4191),边界靠模块划分,不靠 server 拓扑。
//
// 这里也是 agent 与宿主之间的 id 边界(id 收敛第三刀,见 typedId.mjs):agent 看到的每个 id 都带类型
// (`session:` / `project:` / `msg:`),传进来的 id 也必须带对类型——裸 UUID 或类型不符当场报错,
// 而不是静默 not found。宿主内部(编排层、DB)照旧裸 UUID;编解码只在这一层做一次。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { appendFileSync } from 'node:fs'
import type { z } from 'zod'
import { TYPED_ID_KINDS, decodeTypedId, encodeTypedId, type TypedIdKind } from '@gugu/core/shared/typedId.mjs'
import { registerGuguTool } from './register-gugu-tool.mjs'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { windowResult, withoutListArgs, type ListSpec } from './list-window.mjs'

/** 分派一次工具调用。计时不在这里:整次调用交给宿主的 trackRequest(registerGuguTool),社交域也是它。 */
export type SessionDispatcher = (action: unknown, signal: AbortSignal) => Promise<unknown>

type SessionDispatchAction = { action: string } & Record<string, unknown>

/** 每条 = 一个原子工具:注册名、描述、扁平 schema、宿主分派器侧的动作名(前缀在这里已剥掉)。 */
export interface SessionpageToolDef {
  name: string
  description: string
  schema: z.ZodTypeAny
  /** 宿主分派器的动作名。❌ 别让工具面与分派器各写一份动作名清单。 */
  action: string
  /** 列表工具:结果按 list-window 的约定切窗(顺序是宿主排好的)。 */
  list?: SessionpageListSpec
}

export interface SessionpageListSpec extends ListSpec<Record<string, unknown>> {
  /** 宿主回的是对象时,那张表的键;缺省 = 宿主直接回数组,切完放在 `items` 里。 */
  key?: string
  /** 这个工具自己的筛选参数:在注册机这里判,❌ 传给分派器。 */
  filterKeys?: readonly string[]
  /** 切完窗以后给窗内每一行补东西(同一个分派器、同一道 id 边界):代价只为返回的这一页付。 */
  eachItem?: (item: Record<string, unknown>, call: (action: SessionDispatchAction) => Promise<unknown>) => Promise<Record<string, unknown>>
}

async function eachWindowed(spec: SessionpageListSpec, windowed: unknown, call: (action: SessionDispatchAction) => Promise<unknown>): Promise<unknown> {
  if (!spec.eachItem) return windowed
  const key = spec.key ?? 'items'
  const out = windowed as Record<string, unknown>
  return { ...out, [key]: await Promise.all((out[key] as Record<string, unknown>[]).map((item) => spec.eachItem!(item, call))) }
}

/** id 边界：agent 传进来的带类型 id → 宿主内部裸 id。类型不符 / 裸 id 在这里就报错。
 *  `to`（session_message 的 union 寻址）是例外：条目保持 typed 传给宿主分派器，由它按前缀拆分两条腿。 */
function decodeAction(action: SessionDispatchAction): SessionDispatchAction {
  const out: SessionDispatchAction = { ...action }
  if (typeof out.project_id === 'string') out.project_id = decodeTypedId('project', out.project_id, 'project_id')
  if (typeof out.source_project_id === 'string') out.source_project_id = decodeTypedId('project', out.source_project_id, 'source_project_id')
  if (typeof out.device === 'string') out.device = decodeTypedId('device', out.device, 'device')
  // `project` 是 typed project: id 或那台机器上的目录(与会话页新建会话同一种点名);目录原样交给那台机器解释。
  // 带任一种 typed 前缀的都按 id 解,传成 session: 之类当场说「要的是 project:」,❌ 当成一个叫 session:… 的目录去找。
  if (typeof out.project === 'string') {
    const prefix = out.project.trim().split(':', 1)[0] as TypedIdKind
    if (out.project.includes(':') && TYPED_ID_KINDS.includes(prefix)) out.project_id = decodeTypedId('project', out.project, 'project')
    else out.project_path = out.project
    delete out.project
  }
  if (typeof out.device_id === 'string') {
    out.device = decodeTypedId('device', out.device_id, 'device_id')
    delete out.device_id
  }
  if (typeof out.target_device_id === 'string') {
    out.target_device = decodeTypedId('device', out.target_device_id, 'target_device_id')
    delete out.target_device_id
  }
  if (typeof out.session_id === 'string') {
    out.session_id = decodeTypedId('session', out.session_id, 'session_id')
  }
  if (typeof out.parent_session_id === 'string') {
    out.parent_session_id = decodeTypedId('session', out.parent_session_id, 'parent_session_id')
  }
  if (typeof out.message_id === 'string') {
    out.message_id = decodeTypedId('msg', out.message_id, 'message_id')
  }
  return out
}

/** 出参里的 id 字段 → 带类型。按字段名认，只认这几个宿主自己定义的键。 */
const ID_FIELD_KINDS = {
  session_id: 'session',
  spawned_by_session_id: 'session',
  parent_session_id: 'session',
  related_session_id: 'session',
  recipient_session_id: 'session',
  sender_session_id: 'session',
  project_id: 'project',
  source_project_id: 'project',
  linked_project_id: 'project',
  message_id: 'msg',
  device_id: 'device',
  spawned_by_device_id: 'device',
} as const

type PictureBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const isPicture = (value: unknown): value is { label: string; mimeType: string; data: string } =>
  typeof value === 'object' && value !== null &&
  typeof (value as { label?: unknown }).label === 'string' &&
  typeof (value as { mimeType?: unknown }).mimeType === 'string' &&
  typeof (value as { data?: unknown }).data === 'string'

/**
 * A result's `pictures` (app_check, and app_install's check — `{ label, mimeType, data }`, extension-look-picture.ts) go
 * to the agent as image blocks after the JSON, each said by its label: never as base64 text inside the JSON (~40 KB
 * each, in the agent's context), and never into the audit.
 */
export function withPictures(result: unknown): { shown: unknown; pictures: PictureBlock[] } {
  if (result === null || typeof result !== 'object' || Array.isArray(result) || !('pictures' in result)) return { shown: result, pictures: [] }
  const { pictures, ...shown } = result as { pictures?: unknown }
  if (!Array.isArray(pictures) || !pictures.every(isPicture)) throw new Error('host returned pictures that are not { label, mimeType, data }')
  return {
    shown,
    pictures: pictures.flatMap((picture): PictureBlock[] => [
      { type: 'text', text: `Picture: ${picture.label}` },
      { type: 'image', data: picture.data, mimeType: picture.mimeType },
    ]),
  }
}

function encodeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeResult)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const kind = (ID_FIELD_KINDS as Record<string, (typeof ID_FIELD_KINDS)[keyof typeof ID_FIELD_KINDS]>)[key]
    if (kind && typeof entry === 'string' && entry.length > 0) out[key] = encodeTypedId(kind, entry)
    else if (kind) out[key] = entry
    else out[key] = encodeResult(entry)
  }
  return out
}

/**
 * Test-only evidence for the real ACP path. The provider's raw ACP export keeps the tool title and
 * status, but not the MCP arguments or error body. Keep this opt-in and out of normal logs because a
 * delegation prompt can contain user data.
 */
function auditToolCall(entry: {
  phase: 'received' | 'parsed' | 'success' | 'error'
  tool?: string
  rawAction?: unknown
  action?: unknown
  result?: unknown
  error?: unknown
}): void {
  if (process.env.GUGU_SESSION_TEST_HOOKS !== '1') return
  const path = process.env.GUGU_SESSION_TOOL_AUDIT_FILE
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
      error: entry.error instanceof Error
        ? { name: entry.error.name, message: entry.error.message, stack: entry.error.stack }
        : entry.error,
    })}\n`, 'utf8')
  } catch {
    // Evidence must never change the tool's product behaviour.
  }
}

/**
 * 把一个域的原子工具注册进已有 MCP server，动作交给宿主分派器。
 *
 * 分派器可缺席,但**工具清单不随 grant 变**:缺席时该域工具在调用时报 unavailableMessage,
 * 而不是从清单里消失。❌ 别用「不注册」来实现「不许用」—— 工具清单在模型前缀里,少一个
 * 工具就是另一份前缀,整段继承来的上下文都命中不了缓存。
 */
export function registerSessionpageTools(
  server: McpServer,
  defs: readonly SessionpageToolDef[],
  dispatch: SessionDispatcher | undefined,
  unavailableMessage: (toolName: string) => string,
  track: GuguMcpRequestTracker,
): void {
  for (const def of defs) {
    registerGuguTool(server, def, async (rawArgs, signal) => {
      auditToolCall({ phase: 'received', tool: def.name, rawAction: rawArgs })
      let parsed = false
      try {
        const args = (rawArgs ?? {}) as Record<string, unknown>
        const hostArgs = def.list ? withoutListArgs(args, def.list.filterKeys) : args
        const action = decodeAction({ ...hostArgs, action: def.action })
        parsed = true
        auditToolCall({ phase: 'parsed', tool: def.name, action })
        if (!dispatch) throw new Error(unavailableMessage(def.name))
        let result: unknown
        try {
          result = encodeResult(await dispatch(action, signal))
          if (def.list) {
            result = await eachWindowed(def.list, windowResult(def.list, result, args), async (next) =>
              encodeResult(await dispatch(decodeAction(next), signal)))
          }
        } catch (error) {
          auditToolCall({ phase: 'error', tool: def.name, action, error })
          throw error
        }
        const { shown, pictures } = withPictures(result)
        auditToolCall({ phase: 'success', tool: def.name, action, result: shown })
        return { content: [{ type: 'text' as const, text: JSON.stringify(shown) }, ...pictures] }
      } catch (error) {
        if (!parsed) auditToolCall({ phase: 'error', tool: def.name, rawAction: rawArgs, error })
        throw error
      }
    }, track)
  }
}
