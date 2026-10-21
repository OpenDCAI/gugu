import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — MCP implementation is an untyped ESM module.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

// #7351: a session agent has no DM with its owner until one is opened; chat_id = the owner's address opens it.
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const stranger = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const dm = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const token = `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x`
const context = { agentId: agent, threadRootId: null, getAccessToken: async () => token }

/** The attachments function as core's client reaches it: upload → a form → OSS; commit → the message (kept in `commits`). */
function attachmentsFake(uploads: string[], commits: Array<Record<string, unknown>>) {
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) return new Response(JSON.stringify({ staging_key: `staging/o/${uploads.length + 1}`, url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    if (url === 'https://oss.test/') { uploads.push(((init?.body as FormData).get('file') as File).name); return new Response(null, { status: 204 }) }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    commits.push(args)
    return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id } }))
  }) as typeof globalThis.fetch
  return async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch })
}
function deps() {
  const commits: Array<Record<string, unknown>> = []
  const restRpc = vi.fn(async (name: string) => {
    if (name === 'open_dm') return dm
    if (name === 'list_member_ids') return [{ user_id: owner }, { user_id: agent }]
    if (name === 'chat_facts') return [{ kind: 'dm', rules: null }]
    if (name === 'search_users') return []
    return null
  })
  const restGet = vi.fn(async (path: string) => {
    if (path.startsWith('users?id=eq.')) return [{ id: owner, gugu_number: 4242 }]
    if (path.startsWith('chats?')) return [{ id: dm, kind: 'dm' }]
    return []
  })
  const restInsert = vi.fn(async () => [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }])
  return {
    restRpc, restGet, restInsert,
    restInsertReturning: restInsert,
    commits,
    attachmentsEndpoint: attachmentsFake([], commits),
  }
}

describe('chat_id = the owner\'s address (#7351)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-owner-dm-'))
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })

  it.each([`aid:${owner}`, `user:${owner}`, 'gugu:4242'])('%s posts into the owner DM opened for this agent', async (address) => {
    const d = deps()
    await callTool(context, 'message_send', { chat_id: address, text: 'hello owner' }, d)
    expect(d.restRpc).toHaveBeenCalledWith('open_dm', { p_target_user_id: agent })
    const inserted = JSON.stringify(d.restInsert.mock.calls)
    expect(inserted).toContain(dm)
    expect(inserted).not.toContain(address)
  })

  it('sends a file into the same DM', async () => {
    const d = deps()
    const file = join(root, 'report.html')
    writeFileSync(file, '<p>report</p>')
    const result = await callTool(context, 'message_send_file', { chat_id: `aid:${owner}`, file_path: file }, d)
    expect(result).toContain('file sent')
    expect(d.restRpc).toHaveBeenCalledWith('open_dm', { p_target_user_id: agent })
    expect(d.commits).toEqual([expect.objectContaining({ chat_id: dm })])
  })

  it('refuses anyone but the owner and opens nothing', async () => {
    const d = deps()
    await expect(callTool(context, 'message_send', { chat_id: `aid:${stranger}`, text: 'hi' }, d)).rejects.toThrow('only for your owner')
    expect(d.restRpc).not.toHaveBeenCalledWith('open_dm', expect.anything())
    expect(d.restInsert).not.toHaveBeenCalled()
  })
})
