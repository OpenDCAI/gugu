import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — injected MCP host is an untyped ESM module.
import { widgetCheckScopeOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const messageId = '44444444-4444-4444-8444-444444444444'
const agentId = 'agent-1', chatId = 'chat-1'
const context = { agentId, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' }
const content = JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', data: { file: 'poll.json' } })
function source(overrides: Record<string, unknown> = {}, visible = true, members = [agentId], found = true) {
  const restGet = vi.fn(async () => found ? [{ id: messageId, chat_id: chatId, sender_user_id: 'sender-1', content_type: 'widget', content, ...overrides }] : [])
  const restRpc = vi.fn(async (name: string, args: unknown) => {
    if (name === 'can_read_message') {
      expect(args).toEqual({ p_message_id: messageId, p_user_id: agentId })
      return visible
    }
    expect([name, args]).toEqual(['list_member_ids', { p_chat_id: chatId, p_as_user_id: agentId }])
    return members.map(user_id => ({ user_id }))
  })
  return { restGet, restRpc }
}

describe('widget checks use message visibility and membership', () => {
  it('reads once and preserves immutable input and sender', async () => {
    const deps = source()
    await expect(widgetCheckScopeOf(context, messageId, deps)).resolves.toEqual({
      tabKind: 'vote.poll', chatId, widget: { id: messageId, messageId: messageId, senderId: 'sender-1', text: 'Dinner', data: { file: 'poll.json' } },
    })
    expect(deps.restGet).toHaveBeenCalledTimes(1)
    expect(deps.restRpc.mock.calls.map(([name]) => name)).toEqual(['can_read_message', 'list_member_ids'])
  })
  it('h0 preserves the message height in the checked widget scope', async () => {
    const deps = source({ content: JSON.stringify({ ...JSON.parse(content), height: 360 }) })
    expect((await widgetCheckScopeOf(context, messageId, deps)).widget.height).toBe(360)
  })
  it.each([9999, 1.5])('h4 omits invalid message height %s', async height => {
    const deps = source({ content: JSON.stringify({ ...JSON.parse(content), height }) })
    expect((await widgetCheckScopeOf(context, messageId, deps)).widget).not.toHaveProperty('height')
  })
  it.each([
    ['missing', {}, true, [agentId], false],
    ['hidden whisper or before joining', {}, false, [agentId], true],
    ['not a member', {}, true, ['other'], true],
    ['ordinary message', { content_type: 'text' }, true, [agentId], true],
    ['malformed widget', { content: '{"v":1}' }, true, [agentId], true],
  ] as const)('%s reveals no widget information', async (_name, overrides, visible, members, found) => {
    const deps = source(overrides, visible, [...members], found)
    await expect(widgetCheckScopeOf(context, messageId, deps)).rejects.toThrow(`app_check: there is no widget message ${messageId} you can read`)
    if (!visible || !found) expect(deps.restRpc.mock.calls.some(([name]) => name === 'list_member_ids')).toBe(false)
  })
  it('returns a legacy wid but does not scan to resolve a distinct wid', async () => {
    expect((await widgetCheckScopeOf(context, messageId, source({ content: JSON.stringify({ ...JSON.parse(content), wid: 'legacy-wid' }) }))).widget.id).toBe('legacy-wid')
    const absent = source({}, true, [agentId], false)
    await expect(widgetCheckScopeOf(context, 'legacy-wid', absent)).rejects.toThrow('there is no widget message legacy-wid you can read')
    expect(absent.restGet).not.toHaveBeenCalled()
  })
  it.each(['legacy-wid', 'user:x', null, ''])('rejects invalid id %s with the same error before querying a uuid column', async id => {
    const deps = source()
    await expect(widgetCheckScopeOf(context, id, deps)).rejects.toThrow(`app_check: there is no widget message ${id} you can read`)
    expect(deps.restGet).not.toHaveBeenCalled()
    expect(deps.restRpc).not.toHaveBeenCalled()
  })
  it('explains a reference only after permission checks', async () => {
    await expect(widgetCheckScopeOf(context, messageId, source({ content: 'gugu-widget://legacy\n\ngugu-widget://other' }))).rejects.toThrow('pass its widget_id')
    await expect(widgetCheckScopeOf(context, messageId, source({ content: 'gugu-widget://legacy\n\ngugu-widget://other' }, false))).rejects.toThrow(`there is no widget message ${messageId} you can read`)
  })
})
