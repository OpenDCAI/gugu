import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { bestKeywordMatches } from '../../../../apps/desktop/src/session/shared/extensions/query-score'
import { setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'

// #7335 catalog_list 按关键词搜:从前 name 只是工具名子串,"create app" / "创建" 都是 0 条(d22 实测)。

const entries = [
  { row: 'app_create', text: 'app_create A chat App: template "group-json", your whole app.js in files.' },
  { row: 'app_pack', text: 'app_pack Only for sharing an App with other people: pack a bundle into a .guguext file.' },
  { row: 'workspace__create', text: 'workspace__create Put a new file in a chat\'s folder.' },
  { row: 'message_send_file', text: 'message_send_file Post a file from this machine as an attachment.' },
]

describe('bestKeywordMatches (#7335)', () => {
  it('splits the words, so a name asked the other way round is found', () => {
    expect(bestKeywordMatches(entries, 'create app')).toEqual(['app_create'])
    expect(bestKeywordMatches(entries, 'app_create')).toEqual(['app_create'])
  })

  it('searches descriptions, not only names', () => {
    expect(bestKeywordMatches(entries, 'folder')).toEqual(['workspace__create'])
  })

  it('returns only the best tier: a stray common word does not pull in the whole catalog', () => {
    expect(bestKeywordMatches(entries, 'send a file')).toEqual(['message_send_file'])
    // No row has both words: the rows with the most words matched come back.
    expect(bestKeywordMatches(entries, 'create extension')).toEqual(['app_create', 'workspace__create'])
  })

  // 10-19 中文不用空格分词:「一起玩海龟汤」从前是一个词,整词不在任何描述里 ⇒ 0 条(本机实测)。
  it('a Chinese phrase finds the App whose name it contains, first, over rows that share only a word of it', () => {
    const apps = [
      { row: 'together', text: 'together 一起 Edit one file together: 大家一起改。' },
      { row: 'turtle-soup', text: 'turtle-soup 海龟汤 海龟汤（情境推理）:大家一起问出关键、还原汤底。' },
      { row: 'turtle-soup__host', text: 'turtle-soup__host Take a 海龟汤 (turtle soup) round as its host.' },
    ]
    expect(bestKeywordMatches(apps, '一起玩海龟汤')).toEqual(['turtle-soup', 'turtle-soup__host'])
    expect(bestKeywordMatches(apps, '海龟汤')).toEqual(['turtle-soup', 'turtle-soup__host'])
    // A whole word matched still counts most: 「一起」 is in both rows that say it, 「海龟汤」 adds only where it is.
    expect(bestKeywordMatches(apps, '一起 海龟汤')).toEqual(['turtle-soup'])
    // Two characters are the shortest piece: 「玩汤」 shares one character with each row and finds none.
    expect(bestKeywordMatches(apps, '玩汤')).toEqual([])
    // English is scored as before: a word matches whole or not at all.
    expect(bestKeywordMatches(apps, 'turtle game')).toEqual(['turtle-soup', 'turtle-soup__host'])
  })

  it('no words = every row; nothing matched = none', () => {
    expect(bestKeywordMatches(entries, '  ')).toEqual(entries.map((entry) => entry.row))
    expect(bestKeywordMatches(entries, '创建')).toEqual([])
  })
})

describe('catalog_list on a real host finds the App tools by what they do (#7335)', () => {
  let host: DesktopGuguMcpHost | undefined
  afterEach(async () => {
    setExtensionCheckAvailable(false)
    await host?.dispose().catch(() => undefined)
    host = undefined
  })

  it('"create app" lists app_create, and only a few rows', async () => {
    setExtensionCheckAvailable(true)
    host = createDesktopGuguMcpHost()
    await host.start()
    const grant = await host.grant('catalog-search', {
      kind: 'social',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      supabaseUrl: 'https://supabase.example',
      anonKey: 'anon-key',
      agentId: 'agent-1',
      threadRootId: null,
      guguHome: '/tmp/gugu-catalog-search',
      getAccessToken: async () => 'token',
      runSessionAction: async () => ({}),
      runExtensionAction: async () => ({}),
    })
    const client = new Client({ name: 'catalog-search-probe', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
    }))
    const list = async (name?: string) => {
      const result = await client.callTool({ name: 'catalog_list', arguments: name === undefined ? {} : { name } })
      const body = (result.content as Array<{ text: string }>)[0]!.text
      return (JSON.parse(body) as { items: Array<{ call?: string }> }).items.map((item) => item.call?.slice(0, item.call.indexOf('(')))
    }
    const all = await list()
    const found = await list('create app')
    // 阳控:目录本身不空、app_create 确实在目录里(否则「找到了」无从谈起)。
    expect(all).toContain('app_create')
    expect(found).toContain('app_create')
    expect(found.length).toBeLessThan(all.length / 4)
    await client.close()
  })

  // #7317 the owner's test: 「用我的电脑计算器按一个 6+6+6+6+6 的和」. Two agents searched the catalog for computer, screen,
  // mouse, desktop, mac, "macos screen mouse control" and never met device_actions, already in their own list.
  it('a search for the computer finds device_actions, marked native; the unsearched listing still leaves it out', async () => {
    host = createDesktopGuguMcpHost()
    await host.start()
    const grant = await host.grant('catalog-computer', {
      kind: 'social',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      supabaseUrl: 'https://supabase.example',
      anonKey: 'anon-key',
      agentId: 'agent-1',
      threadRootId: null,
      guguHome: '/tmp/gugu-catalog-computer',
      getAccessToken: async () => 'token',
      runSessionAction: async () => ({}),
      runExtensionAction: async () => ({}),
    })
    const client = new Client({ name: 'catalog-computer-probe', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
    }))
    const rows = async (name?: string) => {
      const result = await client.callTool({ name: 'catalog_list', arguments: name === undefined ? {} : { name } })
      const body = (result.content as Array<{ text: string }>)[0]!.text
      return (JSON.parse(body) as { items: Array<{ call?: string; native?: boolean; about?: string }> }).items
    }
    const named = (items: Array<{ call?: string }>) => items.map((item) => item.call?.slice(0, item.call.indexOf('(')))
    for (const query of ['computer', 'screen', 'mouse', 'desktop', 'mac', 'macos screen mouse control', 'Computer Use']) {
      const found = await rows(query)
      expect(named(found), query).toContain('device_actions')
      expect(found.find((item) => item.call?.startsWith('device_actions('))).toMatchObject({ native: true, about: expect.stringContaining('Computer Use') })
    }
    // The listing without a query is what it was: tools not in the agent's own list.
    expect(named(await rows())).not.toContain('device_actions')
    // Control: a query about something else does not bring it.
    expect(named(await rows('create app'))).not.toContain('device_actions')
    await client.close()
  })
})
