// 摩擦单 F5:app_check 让宿主按一个群、一个文件把 App 开成隐藏页,再把页面上的字交给 agent ——
// 所以只能是这个 agent 自己在的群、它自己读得到的文件(workspace_*_as 那条判据:按 agent 本人,不按它的主人)。
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { extensionCheckScopeOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const AGENT = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const CHAT = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const ITEM = '55555555-5555-4555-8555-555555555555'
const TOPIC = '66666666-6666-4666-8666-666666666666'
const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' }

function injected({ members = [AGENT, BOB], visibleItem = true } = {}) {
  const calls: { name: string; body: Record<string, unknown> }[] = []
  return {
    calls,
    deps: {
      // The group's public_id, as message_conversations shows it: 208920 is CHAT, 208921 is OTHER.
      restGet: async (path: string) => {
        const publicId = /chats\?public_id=eq\.(\d+)/.exec(path)?.[1]
        if (publicId === '208920') return [{ id: CHAT, public_id: 208920 }]
        if (publicId === '208921') return [{ id: OTHER, public_id: 208921 }]
        throw new Error(`unexpected read ${path}`)
      },
      restRpc: async (name: string, body: Record<string, unknown>) => {
        calls.push({ name, body })
        if (name === 'workspace_get_as') {
          // The RPC itself refuses an item the agent may not read (not a member, or no such item).
          if (!visibleItem) throw new Error(`command RPC HTTP 400: workspace item not found: ${String(body.p_item_id)}`)
          return [{ id: ITEM, chat_id: CHAT, filename: 'friday.vote.json' }]
        }
        if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: body.p_chat_id === TOPIC ? 'topic' : 'group', source_chat_id: body.p_chat_id === TOPIC ? CHAT : null }]
        if (name === 'list_member_ids') return members.map((user_id) => ({ user_id }))
        throw new Error(`unexpected rpc ${name}`)
      },
    },
  }
}

describe('app_check: which group and file the hidden page may run in', () => {
  test('a topic opens the source slot, with or without an explicit file', async () => {
    await expect(extensionCheckScopeOf(context, { chatId: TOPIC, itemId: ITEM }, injected().deps)).resolves.toEqual({ chatId: CHAT, itemId: ITEM })
    await expect(extensionCheckScopeOf(context, { chatId: TOPIC }, injected().deps)).resolves.toEqual({ chatId: CHAT })
  })
  test('a file names its group; it is read as the agent itself', async () => {
    const { calls, deps } = injected()
    await expect(extensionCheckScopeOf(context, { itemId: ITEM }, deps)).resolves.toEqual({ chatId: CHAT, itemId: ITEM })
    expect(calls).toEqual([{ name: 'workspace_get_as', body: { p_item_id: ITEM, p_as_user_id: AGENT } }])
  })

  test('a file the agent may not read is refused, as its own door refuses it', async () => {
    await expect(extensionCheckScopeOf(context, { itemId: ITEM }, injected({ visibleItem: false }).deps))
      .rejects.toThrow(/workspace item not found/)
  })

  test('a file and a group that do not match are refused', async () => {
    await expect(extensionCheckScopeOf(context, { chatId: OTHER, itemId: ITEM }, injected().deps))
      .rejects.toThrow(`file ${ITEM} is in chat ${CHAT}, not ${OTHER}`)
  })

  // L5 S1 复跑:agent 给的是群的 public_id,被说成「文件在别的群」。chat_id 和别的工具同一个解析:同一个群哪种写法都放行。
  test('chat_id as a public_id is the same group: with its file it passes, alone it is that group; another group still does not', async () => {
    await expect(extensionCheckScopeOf(context, { chatId: '208920', itemId: ITEM }, injected().deps))
      .resolves.toEqual({ chatId: CHAT, itemId: ITEM })
    await expect(extensionCheckScopeOf(context, { chatId: '208920' }, injected().deps)).resolves.toEqual({ chatId: CHAT })
    // 对照:另一个群的 public_id 照旧拒。
    await expect(extensionCheckScopeOf(context, { chatId: '208921', itemId: ITEM }, injected().deps))
      .rejects.toThrow(`file ${ITEM} is in chat ${CHAT}, not 208921`)
  })

  test('a group alone: the agent must be in it (its owner being in it is not enough)', async () => {
    await expect(extensionCheckScopeOf(context, { chatId: CHAT }, injected().deps)).resolves.toEqual({ chatId: CHAT })
    await expect(extensionCheckScopeOf(context, { chatId: CHAT }, injected({ members: [BOB] }).deps))
      .rejects.toThrow(`app_check: you are not in chat ${CHAT}`)
  })
})
