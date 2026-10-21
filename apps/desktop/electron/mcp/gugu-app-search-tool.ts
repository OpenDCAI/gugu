// app_search —— 找 App 的唯一入口(owner 10-19「想想怎么多维度,分页筛选,要认真做了」「catalog_list … 不应该在 catalog_list
// 里面按名字搜索啥吧」)。已装的(on / off / not_given / unavailable)与市场里的,一起筛选、打分、排序、计分面 —— 那一份规矩在
// shared 的 app-search.ts,界面的 App 页用同一份。不进原生列表(GUGU_LISTED_TOOLS 的预算),经 catalog_call 调;<gugu_apps>
// 点名它。只读:不装、不启用,下一步写在每行的 next 里。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  APP_RISKS,
  APP_SEARCH_SORTS,
  APP_SEARCH_STATES,
  appCategories,
  appRisk,
  searchApps,
  type AppSearchRecord,
} from '../../src/session/shared/extensions/app-search'
import { firstSentence } from './first-sentence'
import { describeWindow, listRowsSchema, parseRows } from './list-window.mjs'
import { assertMcpToolDescriptionWithinBudget } from './mcp-tool-description-budget.mjs'

/** A record as the host hands it to app_search: the App, and what the agent does with it next. */
export interface AppSearchHit extends AppSearchRecord {
  next?: string
  /** An App that is on: its tabs' tab_kind (session_open_in_tab, app_check). */
  tabs?: string[]
}
/** The Apps this session reaches, read at every call; null where Apps do not reach the session (a side chat). */
export type AppSearchSource = () => Promise<{ apps: AppSearchHit[]; market?: string }> | null

/**
 * One page at most this many rows, and by default. A row is up to ~600 bytes (an about of 120 Chinese characters is 360);
 * ten with the facets stay under 6.5 KB, inside one output's 8 000 bytes (TOOL_OUTPUT_BYTE_BUDGET, Codex cuts the middle
 * past it). More is a next page, never a longer one.
 */
export const APP_SEARCH_PAGE_ROWS = 10
/** An about is the description's first sentence, cut here — the cut of an App's line in <gugu_apps>. */
const ABOUT_MAX_CHARS = 120

const about = (description: string | undefined) => {
  const chars = [...firstSentence(description ?? '')]
  return chars.length <= ABOUT_MAX_CHARS ? chars.join('') : `${chars.slice(0, ABOUT_MAX_CHARS - 1).join('')}…`
}

const DESCRIPTION = 'Find Apps — installed here (on, switched off, not given to you, unusable) and in the market — by keywords, state, category, risk or a file they open; each row says what to do next, facets count what narrowing would leave.'

const schema = z.object({
  query: z.string().optional().describe('Keywords: name, id, description, categories.'),
  state: z.array(z.enum(APP_SEARCH_STATES)).optional(),
  category: z.array(z.string()).optional().describe('As facets.category names them.'),
  max_risk: z.enum(APP_RISKS).optional().describe('Only Apps whose permissions are at most this loud; none = it asks for none.'),
  opens: z.string().optional().describe('A file suffix, e.g. .pdf: Apps with a tab that opens it.'),
  sort: z.enum(APP_SEARCH_SORTS).optional().describe('relevance with a query, else name; newest = first published, updated = this version.'),
  rows: listRowsSchema,
}).strict()

export function registerGuguAppSearchTool(server: McpServer, source: AppSearchSource): void {
  assertMcpToolDescriptionWithinBudget('app_search', DESCRIPTION)
  server.registerTool('app_search', { description: DESCRIPTION, inputSchema: schema }, async (args) => {
    // 侧边聊天(分叉)不带 App(与目录同一条规矩):说清楚,❌ 回一张空表。
    const found = source()
    if (!found) throw new Error('app_search is unavailable here: Apps reach a session of yours, not a side chat')
    const window = parseRows(args.rows, APP_SEARCH_PAGE_ROWS)
    if (window.to - window.from + 1 > APP_SEARCH_PAGE_ROWS) {
      throw new Error(`app_search gives at most ${APP_SEARCH_PAGE_ROWS} rows a call; take the next page with rows "${window.from + APP_SEARCH_PAGE_ROWS}-${window.from + 2 * APP_SEARCH_PAGE_ROWS - 1}"`)
    }
    const { apps, market } = await found
    const { items, facets } = searchApps(apps, args)
    const page = (items as AppSearchHit[]).slice(window.from - 1, window.to).map((hit) => ({
      app: hit.manifest.id,
      name: hit.manifest.name,
      about: about(hit.manifest.description),
      state: hit.state,
      version: hit.version,
      category: appCategories(hit.manifest),
      // What a question like 「不要高风险权限的、最新的」 is answered from, on the row itself (mac1 D 10-19: without them the
      // agent called the oldest App the newest). Days, not times: one row stays short.
      risk: appRisk(hit.manifest),
      ...(hit.firstPublishedAt ? { published: hit.firstPublishedAt.slice(0, 10) } : {}),
      ...(hit.publishedAt ? { updated: hit.publishedAt.slice(0, 10) } : {}),
      ...(hit.next ? { next: hit.next } : {}),
      ...(hit.tabs ? { tabs: hit.tabs } : {}),
    }))
    const result = { ...describeWindow(window, items.length, page.length), items: page, facets, ...(market ? { market } : {}) }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
