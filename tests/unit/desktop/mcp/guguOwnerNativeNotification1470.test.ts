import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — injection-tested ESM MCP implementation.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const dm = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const stranger = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const token = `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x`
const host = () => vi.fn(async (input: Record<string, unknown>) => ({ status: 'sent', message_id: input.request_id, session_id: 'native-session', seq: 3,
  ...(input.file ? { file_name: (input.file as { name: string }).name } : {}) }))
function setup() {
  const runHostAction = host()
  const context = { agentId: agent, threadRootId: null, getAccessToken: async () => token, runHostAction }
  const deps = {
    restGet: vi.fn(async (path: string) => path.startsWith('chats?') ? [{ id: dm, public_id: 218799 }] : []),
    restRpc: vi.fn(async (name: string) => name === 'chat_facts' ? [{ kind: 'dm', rules: null }] : name === 'list_member_ids' ? [{ user_id: owner }, { user_id: agent }] : null),
    restInsert: vi.fn(),
    attachmentsEndpoint: vi.fn(() => { throw new Error('must not upload into the legacy DM') }),
  }
  return { context, deps, runHostAction }
}

describe('owner sends commit into the bound native session', () => {
  it.each([`user:${owner}`, `aid:${owner}`, dm, '218799'])('resolves %s to the same host action without creating or writing a DM', async chatId => {
    const { context, deps, runHostAction } = setup()
    const receipt = JSON.parse(await callTool(context, 'message_send', { chat_id: chatId, text: 'Review the result' }, deps))
    expect(runHostAction).toHaveBeenCalledExactlyOnceWith({ action: 'owner-notify', request_id: expect.any(String), agent_user_id: agent, text: 'Review the result' })
    expect(receipt).toMatchObject({ status: 'sent', delivery: 'owner-native', session_id: 'native-session', seq: 3 })
    expect(deps.restRpc).not.toHaveBeenCalledWith('open_dm', expect.anything())
    expect(deps.restInsert).not.toHaveBeenCalled()
  })
  it.each([`user:${owner}`, dm, '218799'])('commits an HTML snapshot using the same destination rule (%s)', async chatId => {
    const { context, deps, runHostAction } = setup()
    const receipt = JSON.parse(await callTool(context, 'message_send_file', { chat_id: chatId, file_path: '/work/report.html' }, deps))
    expect(runHostAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'owner-notify', text: '', file: { path: '/work/report.html', name: 'report.html', mime_type: 'text/html' } }))
    expect(receipt).toMatchObject({ delivery: 'owner-native', file_name: 'report.html' })
    expect(deps.attachmentsEndpoint).not.toHaveBeenCalled()
    expect(deps.restInsert).not.toHaveBeenCalled()
  })
  it('waits for the actual host commit and propagates its failure', async () => {
    const { context, deps } = setup()
    context.runHostAction = vi.fn(async () => { throw new Error('SQLite commit failed') })
    await expect(callTool(context, 'message_send', { chat_id: `user:${owner}`, text: 'notify' }, deps)).rejects.toThrow('SQLite commit failed')
    expect(deps.restInsert).not.toHaveBeenCalled()
  })
  it('refuses a missing host, a receipt for another request, and a foreign recipient', async () => {
    const { context, deps } = setup()
    await expect(callTool({ ...context, runHostAction: undefined }, 'message_send', { chat_id: `user:${owner}`, text: 'notify' }, deps)).rejects.toThrow('host is unavailable')
    await expect(callTool({ ...context, runHostAction: async () => ({ status: 'sent', message_id: 'other', session_id: 's', seq: 0 }) }, 'message_send', { chat_id: dm, text: 'notify' }, deps)).rejects.toThrow('did not confirm')
    await expect(callTool(context, 'message_send', { chat_id: dm, text: 'notify', to_user_ids: [`user:${stranger}`] }, deps)).rejects.toThrow('only your owner')
    expect(deps.restInsert).not.toHaveBeenCalled()
  })
  it('does not interpret another identity as an owner notification', async () => {
    const { context, deps, runHostAction } = setup()
    await expect(callTool(context, 'message_send', { chat_id: `user:${stranger}`, text: 'notify' }, deps)).rejects.toThrow('only for your owner')
    expect(runHostAction).not.toHaveBeenCalled()
    expect(deps.restRpc).not.toHaveBeenCalledWith('open_dm', expect.anything())
  })
})
