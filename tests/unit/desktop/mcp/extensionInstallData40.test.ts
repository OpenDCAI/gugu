// 摩擦单 F40(S2:8 次调用、1m57s,时间几乎全在模型往返):群 App 的常见路径压成 create → install → 发消息。
// app_install { chat_id, data } 一次做完四件:装在这台、建群里的数据文件、在它上面 check、check 通过才发卡片。
// 走真的会话 MCP 面(工具层 + MCP 层),只把「建数据文件」「发卡片」两步换成假的(它们自己的单测在 guguImMcp)。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CARD = '0c000000-0000-4000-8000-000000000040'
const ITEM = '0d000000-0000-4000-8000-000000000040'
const CHAT = '0e000000-0000-4000-8000-000000000040'
const LINK = `[周五吃什么.dinner-vote.json](gugu-file://${ITEM})`
const sendCard = vi.fn()
const dataFile = vi.fn()
vi.mock('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendExtensionCardOf: (...args: unknown[]) => sendCard(...args),
  groupDataFileOf: (...args: unknown[]) => dataFile(...args),
}))

const { createDesktopGuguMcpHost } = await import('../../../../apps/desktop/electron/acp-engine-utils')
const { setExtensionCheckAvailable } = await import('../../../../apps/desktop/electron/mcp/gugu-extension-tool')
const { INSTALLED_NOT_SHOWN_NOTE } = await import('../../../../apps/desktop/src/session/shared/extensions/host-actions')
type Host = ReturnType<typeof createDesktopGuguMcpHost>

const hosts: Host[] = []
const clients: Client[] = []
beforeEach(() => {
  setExtensionCheckAvailable(true)
  sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: false, differs: false })
  dataFile.mockResolvedValue({ item: { id: ITEM, chat_id: CHAT }, link: LINK, reused: false })
})
afterEach(async () => {
  windowConfirmed = true
  setExtensionCheckAvailable(false)
  sendCard.mockReset()
  dataFile.mockReset()
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? '').join('')

let windowConfirmed = true
const VOTE_TABS = [{ name: 'main', tab_kind: 'dinner-vote.main', chat_files: ['.dinner-vote.json'] }]
async function agent(checkReport: Record<string, unknown>, tabs: unknown[] = VOTE_TABS) {
  const seen: string[] = []
  const checks: unknown[] = []
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  await host.start()
  const grant = await host.grant('f40', {
    kind: 'social',
    expectedOwnerUserId: 'owner-1',
    subjectId: 'agent-1',
    supabaseUrl: 'https://supabase.example',
    anonKey: 'anon-key',
    agentId: 'agent-1',
    threadRootId: null,
    guguHome: '/tmp/gugu-f40-test',
    getAccessToken: async () => 'token',
    runSessionAction: async () => ({}),
    runExtensionAction: async (action: unknown) => {
      const { action: name } = action as { action: string }
      seen.push(name)
      if (name === 'install') {
        return {
          installed: true, id: 'dinner-vote', version: '1.0.0',
          ...(windowConfirmed
            ? { next: 'It is in the chat as a card now.' }
            : { window: 'not-confirmed', next: `${INSTALLED_NOT_SHOWN_NOTE} It is in the chat as a card now.` }),
          tabs,
        }
      }
      if (name === 'check') {
        checks.push(action)
        return { ...checkReport, next: 'check next' }
      }
      return { file_path: '/tmp/dinner-vote-1.0.0.guguext', file_name: 'dinner-vote-1.0.0.guguext', sha256: 'f'.repeat(64) }
    },
  })
  const client = new Client({ name: 'f40', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } } }))
  const install = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'app_install', arguments: args })
    return { isError: result.isError === true, body: text(result) }
  }
  return { install, seen, checks }
}

const DATA = { title: '周五吃什么', content: { question: 'Friday?', votes: {} } }

describe('app_install { chat_id, data }: installed, its data file, checked, then the card (F40)', () => {
  it('a clean check: all four done in one call, and the answer says each', async () => {
    const { install, seen } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'Friday? — 0 votes' })
    const answer = await install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(seen).toEqual(['install', 'check', 'pack'])
    expect(dataFile).toHaveBeenCalledWith(expect.anything(), { chatId: CHAT, name: '周五吃什么.dinner-vote.json', content: DATA.content })
    expect(body).toMatchObject({
      installed: true,
      data_file: { item_id: ITEM, link: LINK, reused: false },
      check: { ok: true, text: 'Friday? — 0 votes' },
      message_id: `msg:${CARD}`,
    })
    expect(body.check.next).toBeUndefined()
    expect(body.next).toBe(`Checked on it: ok. It is in the chat as a card now. Tell the chat, with the data file's link: ${LINK}`)
  })

  it('a failing check: installed and the data file kept, but no card — the group never gets an App that fails', async () => {
    const { install, seen } = await agent({ ok: false, loaded: true, errors: [{ kind: 'uncaught', level: 'error', message: 'TypeError: votes is undefined' }], console: [], text: '' })
    const body = JSON.parse((await install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })).body)
    expect(seen).toEqual(['install', 'check'])
    expect(sendCard).not.toHaveBeenCalled()
    expect(body.message_id).toBeUndefined()
    expect(body.check.errors[0].message).toBe('TypeError: votes is undefined')
    expect(body.next).toMatch(/but the check found problems \(check\) — so the card was not sent/)
    expect(body.next).toMatch(/app_install again with the same chat_id and data: the data file is kept/)
  })

  it('the data file could not be made: still installed and shared, and said why — not an error', async () => {
    dataFile.mockRejectedValue(new Error('the data file 周五吃什么.dinner-vote.json was not made: a JSON file lives as an object at the top ({...}); this one is not'))
    const { install, seen } = await agent({ ok: true })
    const answer = await install({ source_dir: '/tmp/vote', chat_id: CHAT, data: { title: '周五吃什么', content: [1, 2] } })
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(seen).toEqual(['install', 'pack'])
    expect(body.message_id).toBe(`msg:${CARD}`)
    expect(body.next).toMatch(/^The data file was not made \(.*a JSON file lives as an object at the top/)
  })

  // 主人 10-05「私聊也是得有面板的」:私聊和群是同一种对话 —— 数据文件建在私聊的工作区、在它上面 check、发卡片,一样走完。
  // 对照(父提交,F80):私聊里装好就停,不建数据文件、不发卡片,回一句「卡片和数据文件只进群」。
  // 这一层不再问是哪种对话(F80 那次读 kind 删了):chat_id 是私聊还是群,走的是同一段。
  it('a private chat is a chat like a group: its data file, the check and the card, in one call', async () => {
    const { install, seen } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'Friday? — 0 votes' })
    const answer = await install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(seen).toEqual(['install', 'check', 'pack'])
    expect(dataFile).toHaveBeenCalledWith(expect.anything(), { chatId: CHAT, name: '周五吃什么.dinner-vote.json', content: DATA.content })
    expect(sendCard).toHaveBeenCalledTimes(1)
    expect(body.next).not.toMatch(/private chat|only (go|goes) to a group/)
  })

  it('data without chat_id is refused before anything is done', async () => {
    const { install, seen } = await agent({ ok: true })
    const answer = await install({ source_dir: '/tmp/vote', data: DATA })
    expect(answer.isError).toBe(true)
    expect(answer.body).toContain('app_install: data is the data file of a chat — it goes with chat_id')
    expect(seen).toEqual([])
  })

  // 摩擦单 F52:窗口还没点头的那一句由主进程写在 next 开头;这里改写 next(检查没过、卡片没发)时它仍在最前面。
  it('a window that has not taken the install in: its sentence stays first when this call rewrites next', async () => {
    windowConfirmed = false
    const failing = { ok: false, loaded: true, errors: [{ kind: 'uncaught', level: 'error', message: 'boom' }], console: [], text: '' }
    const checked = JSON.parse((await (await agent(failing)).install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })).body)
    expect(checked.installed).toBe(true)
    expect(checked.next.startsWith(`${INSTALLED_NOT_SHOWN_NOTE} Installed on your owner's computer`)).toBe(true)

    sendCard.mockRejectedValue(new Error('read the group rules first'))
    const unsent = JSON.parse((await (await agent({ ok: true, loaded: true, errors: [], console: [], text: 'ok' })).install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })).body)
    expect(unsent.next.startsWith(`${INSTALLED_NOT_SHOWN_NOTE} The card was not sent`)).toBe(true)
  })

  it('a reinstall after a fix keeps the data file (reused) and names it in the answer', async () => {
    dataFile.mockResolvedValue({ item: { id: ITEM, chat_id: CHAT }, link: LINK, reused: true })
    const { install } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'ok' })
    const body = JSON.parse((await install({ source_dir: '/tmp/vote', chat_id: CHAT, data: DATA })).body)
    expect(body.data_file).toEqual({ item_id: ITEM, link: LINK, reused: true })
  })
})

// 摩擦单 F102(L7-t,S20):B 上传了 975 KB 的 catalog.json,agent 却把整份目录打进 App 包、首次打开再写进另一个新文件 ——
// 群里两份目录,人改的永远到不了 catalog.json。数据已经在群里,App 就打开那个文件本身:data { item_id },不建新文件,
// check 在它上面演练,卡片和链接都指向它;App 没认领它(名字或后缀)就不发卡片,说怎么认领 —— ❌ 改人的文件名。
describe('app_install { chat_id, data: { item_id } }: the file already in the group is the data (F102)', () => {
  const CATALOG = '0f000000-0000-4000-8000-000000000102'
  const CATALOG_LINK = `[catalog.json](gugu-file://${CATALOG})`
  beforeEach(() => {
    dataFile.mockResolvedValue({ item: { id: CATALOG, chat_id: CHAT, filename: 'catalog.json' }, link: CATALOG_LINK, reused: true })
  })

  it('claimed by its name: nothing made, checked on that file, the card goes out and the answer links it', async () => {
    const tabs = [{ name: 'main', tab_kind: 'store.main', chat_files: ['catalog.json'] }]
    const { install, seen, checks } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'SKU-00001 · 129' }, tabs)
    const answer = await install({ source_dir: '/tmp/store', chat_id: CHAT, data: { item_id: CATALOG } })
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(dataFile).toHaveBeenCalledWith(expect.anything(), { chatId: CHAT, itemId: CATALOG })
    expect(checks).toEqual([{ action: 'check', tab_kind: 'store.main', chat_id: CHAT, item_id: CATALOG }])
    expect(seen).toEqual(['install', 'check', 'pack'])
    expect(sendCard).toHaveBeenCalledOnce()
    expect(body.data_file).toEqual({ item_id: CATALOG, link: CATALOG_LINK, reused: true })
    expect(body.next).toContain(`Tell the chat, with the data file's link: ${CATALOG_LINK}`)
  })

  it('claimed by its suffix among others: the tab whose claim takes it is the one checked', async () => {
    const tabs = [
      { name: 'board', tab_kind: 'store.board', chat_files: ['.board.json'] },
      { name: 'table', tab_kind: 'store.table', chat_files: ['.json'] },
    ]
    const { install, checks } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'ok' }, tabs)
    await install({ source_dir: '/tmp/store', chat_id: CHAT, data: { item_id: CATALOG } })
    expect(checks).toEqual([{ action: 'check', tab_kind: 'store.table', chat_id: CHAT, item_id: CATALOG }])
  })

  it('a document titled without a suffix goes by its content type, as a click in the chat does: 「投票」 (JSON) is a .json', async () => {
    dataFile.mockResolvedValue({ item: { id: CATALOG, chat_id: CHAT, filename: '投票', content_type: 'application/json' }, link: CATALOG_LINK, reused: true })
    const tabs = [{ name: 'main', tab_kind: 'store.main', chat_files: ['.json'] }]
    const { install, checks } = await agent({ ok: true, loaded: true, errors: [], console: [], text: 'ok' }, tabs)
    const body = JSON.parse((await install({ source_dir: '/tmp/store', chat_id: CHAT, data: { item_id: CATALOG } })).body)
    expect(checks).toEqual([{ action: 'check', tab_kind: 'store.main', chat_id: CHAT, item_id: CATALOG }])
    expect(body.next).not.toContain('does not open')
  })

  it('not claimed: installed, no check, no card — and how to claim it; the file keeps its name', async () => {
    const { install, seen } = await agent({ ok: true }, VOTE_TABS)
    const body = JSON.parse((await install({ source_dir: '/tmp/store', chat_id: CHAT, data: { item_id: CATALOG } })).body)
    expect(seen).toEqual(['install'])
    expect(sendCard).not.toHaveBeenCalled()
    expect(body.installed).toBe(true)
    expect(body.next).toBe(
      'Installed on your owner\'s computer, but this App does not open catalog.json in a chat: it claims .dinner-vote.json. ' +
      'Claim that file by its name or its suffix — opens_files {"chat":["catalog.json"]} — app_create again, then ' +
      'app_install with the same data; the file keeps its name. So the card was not sent.',
    )
  })

  it('a file it cannot open (another chat\'s, a stored file): installed, no card, the reason said', async () => {
    dataFile.mockRejectedValue(new Error(`data.item_id ${CATALOG} is a file of another chat, not ${CHAT}`))
    const { install, seen } = await agent({ ok: true })
    const body = JSON.parse((await install({ source_dir: '/tmp/store', chat_id: CHAT, data: { item_id: CATALOG } })).body)
    expect(seen).toEqual(['install'])
    expect(sendCard).not.toHaveBeenCalled()
    expect(body.next).toContain(`its data could not be opened (data.item_id ${CATALOG} is a file of another chat, not ${CHAT}). So the card was not sent.`)
  })
})
