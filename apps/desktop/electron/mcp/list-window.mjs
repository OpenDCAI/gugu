// 列表类工具的共同约定(spec im-mcp):取哪一段、按名字筛、返回里说清一共几条、这次是哪一段、下一段怎么取。
// 只写这一次:参数片段与切窗函数给 gugu-im-server.mjs 与 sessionpage 注册机(session_* / app_*)两侧共用。
//
// 排序不在这里定:每个列表按它自己的活动时间在数据源那一侧排好(库 RPC 的 ORDER BY、宿主按 last_interacted_at),
// 这里只按那个顺序切。切在 MCP 这一层:数据源要么在宿主内存里,要么是库 RPC 一次整表回来的;
// agent 的上下文只付窗口那一段,这正是要省的那一笔。
import { z } from 'zod'
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '../../../../packages/core/src/shared/agentStatus'

export const LIST_DEFAULT_ROWS = 20

const ROWS_RE = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/

/**
 * `"20"` = 第 1–20 条,`"41-60"` = 第 41–60 条(从 1 数,含两端)。缺省 = 前 `defaultRows` 条(默认 LIST_DEFAULT_ROWS;
 * 目录类传 Infinity = 全给)。写错响亮地拒。
 */
export function parseRows(value, defaultRows = LIST_DEFAULT_ROWS) {
  if (value === undefined || value === null || value === '') return { from: 1, to: defaultRows }
  const match = ROWS_RE.exec(String(value))
  const from = match ? Number(match[2] === undefined ? 1 : match[1]) : NaN
  const to = match ? Number(match[2] === undefined ? match[1] : match[2]) : NaN
  if (!match || from < 1 || to < from) {
    throw new Error(`rows must be a count like "20" or a range like "41-60" (counted from 1), got ${JSON.stringify(value)}`)
  }
  return { from, to }
}

/**
 * 按约定切一张已排好序的表。`spec` 就是工具定义上的 `list`(IM server 与 sessionpage 注册机同一种形状):
 *   · namesOf(row) —— 一行的「名字」,`name` 在这几格里做不分大小写的子串匹配;
 *   · keep(row, args) —— 这个工具自己的筛选;
 *   · statusFilter —— 这个工具收 `status` 筛选词:切窗之前核一次(表是空的、或被别的筛选筛光时,写错的词也要响);
 *   · catalog —— 目录类(harness / 模型 / 扩展):不传 rows 就全给,默认窗口会把排在后面的那一组藏起来。
 * @returns {{ total: number, rows: string | null, next: string | null, items: T[] }}
 *   total = 筛选之后的条数;rows = 这次给的是第几到第几条(一条都没有时为 null);next = 下一段原样传回 rows 即可,没有了为 null。
 */
export function windowList(items, args, spec) {
  if (spec.statusFilter) assertAgentStatusWord(args?.status)
  const { from, to } = parseRows(args?.rows, spec.catalog ? Infinity : LIST_DEFAULT_ROWS)
  const needle = typeof args?.name === 'string' ? args.name.trim().toLocaleLowerCase() : ''
  const matched = items.filter((row) =>
    (!needle || spec.namesOf(row).some((name) => typeof name === 'string' && name.toLocaleLowerCase().includes(needle)))
    && (!spec.keep || spec.keep(row, args ?? {})))
  const page = matched.slice(from - 1, to)
  return { ...describeWindow({ from, to }, matched.length, page.length), items: page }
}

/**
 * 一页的 `rows` / `next` 怎么写,只算这一次:内存里切的(windowList)和数据源那一侧已经分好页的(比如库 RPC 带
 * offset/limit 取回的一页)共用。`window` 是 parseRows 的结果,`total` 是筛选后的总条数,`pageLength` 是这一页实际的条数。
 * @returns {{ total: number, rows: string | null, next: string | null }}
 */
export function describeWindow(window, total, pageLength) {
  const { from, to } = window
  const last = from - 1 + pageLength
  const size = to - from + 1
  return {
    total,
    rows: pageLength ? `${from}-${last}` : null,
    next: last < total && pageLength ? `${last + 1}-${Math.min(last + size, total)}` : null,
  }
}

/**
 * 列表工具的整份结果按约定切窗:数据源回整张排好序的表(`spec.key` 缺省),或带着 `spec.key` 那张表的对象。
 * IM server 与 sessionpage 注册机共用这一个(两边从前各写一份,几乎逐行相同)。
 */
export function windowResult(spec, result, args) {
  const table = spec.key === undefined ? result : result?.[spec.key]
  if (!Array.isArray(table)) throw new Error(`expected a ${spec.key ?? 'list'} to window`)
  const { items, ...window } = windowList(table, args, spec)
  return spec.key === undefined ? { ...window, items } : { ...window, ...result, [spec.key]: items }
}

/** 从一次调用的入参里剥掉列表约定的几格 —— 分派器只收它自己的参数。 */
export function withoutListArgs(args, extraKeys = []) {
  const out = { ...args }
  for (const key of ['rows', 'name', ...extraKeys]) delete out[key]
  return out
}

// ── 参数片段 ── 每个列表工具共用的几格。用法在平台提示词 <gugu_tools> 里讲一次(约定怎么取段、怎么筛、
// status 收哪些词),❌ 在十几个工具里各写一遍说明:工具清单每个会话开场都要付(#6560 的做法)。
export const listRowsSchema = z.preprocess(
  (value) => (typeof value === 'number' ? String(value) : value),
  z.string().optional(),
)
export const listNameSchema = z.string().optional()
export const listWindowShape = { rows: listRowsSchema, name: listNameSchema }

// agent 状态复用 core 词表；会话列表另有生命周期态 archived。
// 不在 schema 里摊成枚举(每个工具多 250 字符),写错的词在切窗之前响亮地拒,并列出合法的词。
export const AGENT_STATUS_FILTER_WORDS = [...AGENT_STATUSES, ...AGENT_STATUS_DETAILS, 'archived']
export const agentStatusFilterSchema = z.string().optional()
export const pinnedFilterSchema = z.boolean().optional()

/** `status` 筛选词只能是 core 词表里的一个;不传就不筛。 */
export function assertAgentStatusWord(word) {
  if (word === undefined || word === null || word === '') return
  if (!AGENT_STATUS_FILTER_WORDS.includes(word)) {
    throw new Error(`status must be one of ${AGENT_STATUS_FILTER_WORDS.join(', ')}; got ${JSON.stringify(word)}`)
  }
}

/** 一行的 `status` / `detail` 是否命中筛选词。没有状态源(`status: null`)的行不命中任何词。 */
export function matchesAgentStatus(row, word) {
  if (!word) return true
  assertAgentStatusWord(word)
  return row?.status === word || row?.detail === word
}
