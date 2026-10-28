import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_SEARCH_PAGE_ROWS, registerGuguAppSearchTool, type AppSearchHit, type AppSearchSource } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { TOOL_OUTPUT_BYTE_BUDGET } from '../../../../apps/desktop/electron/mcp/mcp-tool-description-budget.mjs'
import { searchApps, type AppSearchRecord, type AppSearchState } from '../../../../apps/desktop/src/session/shared/extensions/app-search'
import type { ExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

// 10-19 owner「想想怎么多维度,分页筛选,要认真做了」: app_search over 60 Apps — every dimension, the facets, the order, the pages.

const STATES: AppSearchState[] = ['on', 'off', 'not_given', 'unavailable', 'market']
const CATEGORIES = ['research', 'productivity', 'developer', 'games']
const PERMISSIONS = [undefined, { capabilities: ['notifications'] }, { capabilities: ['files:read'] }, { network: ['arxiv.org'] }]

/** App i: a state, a category, a risk (none / medium / high / high), opens .pdf every third, dated by i (later = newer). */
function app(i: number, more: { description?: string; next?: string } = {}): AppSearchHit {
  const id = `app-${String(i).padStart(2, '0')}`
  const manifest = {
    id,
    name: `App ${String(i).padStart(2, '0')}`,
    version: `1.0.${i}`,
    description: more.description ?? `Tool number ${i}.`,
    categories: i % 10 === 9 ? undefined : [CATEGORIES[i % CATEGORIES.length]],
    permissions: PERMISSIONS[i % PERMISSIONS.length],
    contributes: { tabs: [{ name: 'main', title: 'Main', ...(i % 3 === 0 ? { opensFiles: { chat: ['.PDF'] } } : {}) }] },
  } as unknown as ExtensionManifest
  const day = String(1 + (i % 28)).padStart(2, '0')
  return {
    manifest,
    state: STATES[i % STATES.length]!,
    version: manifest.version,
    publishedAt: `2026-10-${day}T00:00:00Z`,
    firstPublishedAt: `2026-0${1 + (i % 9)}-01T00:00:00Z`,
    ...(more.next ? { next: more.next } : {}),
  }
}
const SIXTY = Array.from({ length: 60 }, (_, i) => app(i))
const ids = (records: readonly AppSearchRecord[]) => records.map((record) => record.manifest.id)

describe('searchApps (shared: the agent and the Apps page)', () => {
  it('each dimension filters; together they intersect', () => {
    expect(searchApps(SIXTY, { state: ['market'] }).items.every((r) => r.state === 'market')).toBe(true)
    expect(searchApps(SIXTY, { state: ['on', 'off'] }).items).toHaveLength(24)
    expect(ids(searchApps(SIXTY, { category: ['other'] }).items)).toEqual(['app-09', 'app-19', 'app-29', 'app-39', 'app-49', 'app-59'])
    expect(searchApps(SIXTY, { max_risk: 'none' }).items.every((r) => r.manifest.permissions === undefined)).toBe(true)
    expect(searchApps(SIXTY, { max_risk: 'medium' }).items).toHaveLength(30)
    // A suffix with or without its dot, in any case, against a tab's opensFiles.
    expect(searchApps(SIXTY, { opens: 'pdf' }).items).toHaveLength(20)
    expect(searchApps(SIXTY, { opens: '.Pdf' }).items).toHaveLength(20)
    const both = searchApps(SIXTY, { opens: '.pdf', max_risk: 'medium', state: ['market'] }).items
    // i ≡ 0 (mod 3), i ≡ 4 (mod 5), i mod 4 ∈ {0, 1}: 9 and 24 of 0–59.
    expect(ids(both)).toEqual(['app-09', 'app-24'])
  })

  it('facets count each value under every other filter but their own, so a chosen value still shows the others', () => {
    const { facets } = searchApps(SIXTY, { category: ['research'] })
    expect(facets.category).toEqual({ research: 15, productivity: 12, developer: 15, games: 12, other: 6 })
    expect(facets.state).toEqual({ on: 3, off: 3, not_given: 3, unavailable: 3, market: 3 })
    expect(Object.values(facets.risk).reduce((sum, n) => sum + n!, 0)).toBe(15)
  })

  it('sorts: name by default, relevance with a query, newest by first publication, updated by this version; stable under any input order', () => {
    expect(ids(searchApps(SIXTY).items).slice(0, 3)).toEqual(['app-00', 'app-01', 'app-02'])
    const newest = searchApps(SIXTY, { sort: 'newest' }).items
    expect(newest[0]!.firstPublishedAt).toBe('2026-09-01T00:00:00Z')
    const updated = searchApps(SIXTY, { sort: 'updated' }).items
    expect(updated[0]!.publishedAt).toBe('2026-10-28T00:00:00Z')
    // Ties end on the name, then the id: shuffled input, the same order out.
    const shuffled = [...SIXTY].sort(() => 0.5 - Math.random())
    for (const sort of ['name', 'newest', 'updated', 'relevance'] as const) {
      expect(ids(searchApps(shuffled, { sort, query: 'tool' }).items)).toEqual(ids(searchApps(SIXTY, { sort, query: 'tool' }).items))
    }
    // An App the market does not carry has no date: last.
    const undated = { ...app(99), publishedAt: undefined, firstPublishedAt: undefined }
    expect(ids(searchApps([undated, ...SIXTY], { sort: 'newest' }).items).at(-1)).toBe('app-99')
  })

  it('a Chinese phrase finds the App whose name it holds, first; a query nothing matches finds none', () => {
    const soup = { ...app(60), manifest: { ...app(60).manifest, id: 'turtle-soup', name: '海龟汤', description: '海龟汤（情境推理）:大家一起问出关键。' } }
    const together = { ...app(61), manifest: { ...app(61).manifest, id: 'together', name: '一起改', description: '大家一起改一个文件。' } }
    expect(ids(searchApps([together, soup, ...SIXTY], { query: '一起玩海龟汤' }).items)).toEqual(['turtle-soup', 'together'])
    expect(searchApps(SIXTY, { query: '狼人杀' }).items).toEqual([])
  })
})

describe('app_search, the tool', () => {
  const clients: Client[] = []
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  })
  async function connect(source: AppSearchSource) {
    const server = new McpServer({ name: 'app-search', version: '1' })
    registerGuguAppSearchTool(server, source)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'app-search-probe', version: '1' })
    clients.push(client)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'app_search', arguments: args })
      const text = (result.content as Array<{ text: string }>)[0]!.text
      return { isError: result.isError === true, text, body: result.isError ? null : JSON.parse(text) }
    }
    return call
  }

  it('pages of at most ten, with next; a wider window is refused, naming the next page', async () => {
    const call = await connect(async () => ({ apps: SIXTY }))
    const first = await call({})
    expect(first.body).toMatchObject({ total: 60, rows: '1-10', next: '11-20' })
    expect(first.body.items).toHaveLength(APP_SEARCH_PAGE_ROWS)
    expect(first.body.items[0]).toEqual({
      app: 'app-00', name: 'App 00', about: 'Tool number 0.', state: 'on', version: '1.0.0', category: ['research'],
      risk: 'none', published: '2026-01-01', updated: '2026-10-01',
    })
    expect((await call({ rows: '51-60' })).body).toMatchObject({ rows: '51-60', next: null })
    const wide = await call({ rows: '1-30' })
    expect(wide.isError).toBe(true)
    expect(wide.text).toContain('app_search gives at most 10 rows a call; take the next page with rows "11-20"')
  })

  it('the filters and facets reach the agent; a market not reached is said beside the rows', async () => {
    const call = await connect(async () => ({ apps: SIXTY, market: 'not reached (fetch failed); only the Apps installed here were searched' }))
    const found = await call({ opens: '.pdf', max_risk: 'medium', state: ['market'], sort: 'newest' })
    // Newest first: app-24 was first published in July, app-09 in January.
    expect(found.body.items.map((item: { app: string }) => item.app)).toEqual(['app-24', 'app-09'])
    expect(found.body.facets.state).toEqual({ on: 2, off: 2, not_given: 2, unavailable: 2, market: 2 })
    expect(found.body.market).toBe('not reached (fetch failed); only the Apps installed here were searched')
  })

  it('offers conditional creation advice on every result without using the pagination next', async () => {
    const call = await connect(async () => ({ apps: SIXTY }))
    for (const args of [{ query: '井字棋' }, { query: 'Tool' }, { rows: '71-80' }]) {
      const found = await call(args)
      expect(found.body.note).toContain('If none fits and the person wants one made: guide_read apps')
      expect(found.body.note).toContain('chat: group-json')
      expect(found.body.note).toContain('app_install(chat_id, data) → app_check')
      expect(found.body.note).toContain('For a missing feature in an existing App: ask to fork')
    }
    expect((await call({ query: 'Tool' })).body.next).toBe('11-20')
    expect((await call({ query: '井字棋' })).body).toMatchObject({ total: 0, items: [], next: null })
  })

  it('a page of the longest rows fits one output (8 000 bytes)', async () => {
    const long = Array.from({ length: 60 }, (_, i) => app(i, {
      description: `${'很长的描述'.repeat(60)}。Second sentence.`,
      next: `Not installed: catalog_call app_install { market: "app-${i}" } installs it from the market — the call itself asks your owner to confirm files:read, files:write, chat:relay, agents:tools before anything is installed`,
    }))
    const page = await connect(async () => ({ apps: long }))
    const { text, body } = await page({ query: '描述' })
    expect(body.items).toHaveLength(10)
    expect(body.items[0].about).toHaveLength(120)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TOOL_OUTPUT_BYTE_BUDGET)
  })

  it('where Apps do not reach the session (a side chat), it says so', async () => {
    const call = await connect(() => null)
    const refused = await call({})
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('app_search is unavailable here: Apps reach a session of yours, not a side chat')
  })
})
