import { describe, expect, it, vi } from 'vitest'
import { conversationLink, guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'
// @ts-expect-error The injectable MCP dispatcher is JavaScript.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const message = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const context = { agentId: agent, getAccessToken: async () => '', threadRootId: null }

function rig(options: { readable?: boolean; missing?: boolean; page?: object[]; thread?: string | null } = {}) {
  const anchor = { id: message, chat_id: chat, seq: 321, thread_root_id: options.thread ?? null }
  const restGet = vi.fn(async () => options.missing ? [] : [anchor])
  const restRpc = vi.fn(async (name: string) => {
    if (name === 'chat_facts') return options.readable === false ? [] : [{ id: chat, kind: 'group' }]
    if (name === 'can_read_message') return options.readable !== false
    if (name === 'message_history_as') return options.page ?? [anchor, { id: other, seq: 320, content: 'earlier' }]
    if (name === 'message_search_as') return options.page ?? []
    if (name === 'list_topics_of_chat') return [{ chat_id: chat, name: 'Already readable', is_participant: true }]
    throw new Error(`Unexpected RPC: ${name}`)
  })
  return { restGet, restRpc }
}

describe('MCP resource references', () => {
  it('returns the anchor and a bounded page of earlier messages with the same URI and no title copy', async () => {
    const deps = rig({ thread: other })
    const uri = conversationLink(chat, message)
    const rows = JSON.parse(await callTool(context, 'message_history', { chat_id: uri, limit: 7 }, deps))
    expect(rows[0]).toMatchObject({ id: uri })
    expect(rows[0]).not.toHaveProperty('ref')
    expect(deps.restRpc).toHaveBeenCalledWith('can_read_message', { p_message_id: message, p_user_id: agent })
    expect(deps.restRpc).toHaveBeenCalledWith('message_history_as', {
      p_chat_id: chat, p_as_user_id: agent, p_thread_root_id: other, p_before_seq: 322, p_limit: 7,
    })
    expect(deps.restGet).toHaveBeenCalledTimes(1)
  })

  it.each([{ before_seq: 99 }, { thread_root_id: `msg:${other}` }])('rejects conflicting anchor arguments %j', async extra => {
    const deps = rig()
    await expect(callTool(context, 'message_history', { chat_id: conversationLink(chat, message), ...extra }, deps)).rejects.toThrow('cannot be combined')
    expect(deps.restGet).not.toHaveBeenCalled()
  })

  it('never substitutes a neighbouring row for a missing or unreadable anchor', async () => {
    for (const options of [{ readable: false }, { missing: true }, { page: [{ id: other, seq: 320 }] }]) {
      await expect(callTool(context, 'message_history', { chat_id: conversationLink(chat, message) }, rig(options))).rejects.toThrow('Conversation or message is unavailable for this reader')
    }
  })

  it('reports the same failure for an absent and an unreadable empty conversation', async () => {
    for (const name of ['message_history', 'message_search']) {
      await expect(callTool(context, name, { chat_id: conversationLink(chat), query: 'x' }, rig({ readable: false, page: [] }))).rejects.toThrow('Conversation or message is unavailable for this reader')
      expect(JSON.parse(await callTool(context, name, { chat_id: conversationLink(chat), query: 'x' }, rig({ page: [] })))).toEqual([])
    }
  })

  it('keeps opaque injected IDs and rejects malformed or wrong-kind Gugu links', async () => {
    const deps = rig()
    await callTool(context, 'message_history', { chat_id: 'injected-chat' }, deps)
    expect(deps.restRpc).toHaveBeenCalledWith('message_history_as', expect.objectContaining({ p_chat_id: 'injected-chat' }))
    for (const uri of ['gugu-chat://bad', `gugu-file://${message}`]) {
      await expect(callTool(context, 'message_history', { chat_id: uri }, rig())).rejects.toThrow('conversation link')
    }
    await expect(callTool(context, 'message_search', { chat_id: conversationLink(chat, message), query: 'x' }, rig())).rejects.toThrow('names a message')
  })

  it('accepts a source URI without discarding its chat identity', async () => {
    const deps = rig()
    await expect(callTool(context, 'topic_open', { chat_id: chat, source_message_id: conversationLink(other, message) }, deps)).rejects.toThrow('belongs to another chat')
    expect(deps.restGet).not.toHaveBeenCalled()
    const restRpc = vi.fn(async (name: string) => {
      if (name === 'chat_facts') return [{ kind: 'group' }]
      if (name === 'create_topic') return [{ chat_id: other }]
      if (name === 'list_member_ids') return [{ user_id: agent }]
      throw new Error(`Unexpected RPC: ${name}`)
    })
    await callTool(context, 'topic_open', { chat_id: chat, source_message_id: conversationLink(chat, message) }, { restRpc })
    expect(restRpc).toHaveBeenCalledWith('create_topic', expect.objectContaining({ p_source_chat_id: chat, p_source_message_id: message, p_as_user_id: agent }))
  })

  it('uses the readable topic row URI as its chat_id', async () => {
    const rows = JSON.parse(await callTool(context, 'topic_list', { chat_id: conversationLink(chat) }, rig()))
    expect(rows.items[0]).toEqual({ chat_id: conversationLink(chat), name: 'Already readable', is_participant: true })
  })
})

describe('session item reference identity', () => {
  it('round-trips opaque case-sensitive session/item identities through the shared parser', () => {
    const target = { kind: 'session' as const, sessionId: 'Session-A', itemId: 'turn:2/item(1)?%=中' }
    expect(parseGuguLink(guguLink(target))).toEqual(target)
    for (const uri of ['gugu-session://s?message=%ZZ', 'gugu-session://s?message=x&extra=y']) expect(parseGuguLink(uri)).toBeNull()
  })
})
