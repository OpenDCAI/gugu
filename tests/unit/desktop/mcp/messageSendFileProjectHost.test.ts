// message_send_file in a project chat that keeps files on its machine: on that machine a file other than an image is published
// by the host's own publisher (the composer's) and stays there; an image is uploaded when sent; elsewhere the refusal says why.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const CHAT = '00000000-0000-4000-8000-000000000001'
const dir = mkdtempSync(join(tmpdir(), 'gugu-send-project-host-'))
const pdf = join(dir, 'notes.pdf'), png = join(dir, 'shot.png')
writeFileSync(pdf, '%PDF-1.4 fixture'); writeFileSync(png, 'png bytes')
const envelope = '[附件] notes.pdf (application/pdf)\n[Size] 16\n[Kind] file'

function setup(options: { publish?: ReturnType<typeof vi.fn>; refuse?: boolean } = {}) {
  const uploads: Array<Record<string, unknown>> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) {
      uploads.push(JSON.parse(String(init?.body)))
      return options.refuse
        ? new Response(JSON.stringify({ error: 'denied', message: 'Project files are not uploaded proactively' }), { status: 403 })
        : new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    }
    if (url === 'https://oss.test/') return new Response(null, { status: 204 })
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id, content: '[附件] shot.png (image/png)\n[Size] 9\n[Kind] image' } }))
  }) as typeof globalThis.fetch
  const deps: Record<string, unknown> = {
    restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }]
      : path.startsWith('users?id=eq.owner-1') ? [{ display_name: 'Ming' }] : [],
    restInsert: async () => { throw new Error('a file card is never a direct insert') },
    restRpc: async (name: string) => name === 'chat_facts' ? [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      : name === 'list_member_ids' ? [{ user_id: 'agent-1', role: 'member' }]
      : name === 'file_project_policy_for' ? { host_device_id: 'mac-1', host_account_id: 'owner-1' } : null,
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  const context = { supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null, guguHome: dir,
    getAccessToken: async () => 'token', ...(options.publish ? { publishFile: options.publish } : {}) }
  return { send: (args: Record<string, unknown>) => callToolImpl(context, 'message_send_file', { chat_id: CHAT, ...args }, deps), uploads }
}

describe('message_send_file in a project chat that keeps files on its machine', () => {
  test('on the host a file other than an image goes through the host publisher with its message, and no byte is uploaded', async () => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>) => ({ message: { id: message.message_id, chat_id: CHAT, content: envelope } }))
    const { send, uploads } = setup({ publish })
    const receipt = JSON.parse(await send({ file_path: pdf }))
    expect(publish).toHaveBeenCalledOnce()
    const [chat, file, actor, message] = publish.mock.calls[0]!
    expect([chat, actor]).toEqual([CHAT, 'agent-1'])
    expect(file).toEqual({ name: 'notes.pdf', path: pdf, size: 16, contentType: 'application/pdf' })
    expect(message).toMatchObject({ chat_id: CHAT, sender_user_id: 'agent-1', file_name: 'notes.pdf', content_type: 'application/pdf', to_user_ids: [] })
    expect(uploads).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'notes.pdf', message_id: `msg:${message.message_id}` })
  })

  test('an image is uploaded when sent, also on the host, with its type', async () => {
    const publish = vi.fn()
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: png }))).toMatchObject({ status: 'sent', file_name: 'shot.png' })
    expect(publish).not.toHaveBeenCalled()
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'image/png' })])
  })

  test('not the host (the publisher declines): the upload decides, and its refusal says which machine and what to do', async () => {
    const { send } = setup({ publish: vi.fn(async () => null), refuse: true })
    const error = await send({ file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain('notes.pdf was not sent')
    expect(error.message).toContain('on Ming\'s machine')
    expect(error.message).toContain('Settings › File storage')
    expect(error.message).toContain('留在Ming 的机器上')
    expect(error.message).not.toContain('not uploaded proactively')
  })
})
