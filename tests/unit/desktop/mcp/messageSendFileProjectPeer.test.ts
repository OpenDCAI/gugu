// message_send_file in a project chat: a file other than an image goes through this machine's publisher (the composer's) and
// stays on this machine; an image is uploaded when sent; a folder file's next version, an image's too, is published here from
// the version named, on whichever member's machine sends it.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const CHAT = '00000000-0000-4000-8000-000000000001'
const dir = mkdtempSync(join(tmpdir(), 'gugu-send-project-peer-'))
const pdf = join(dir, 'notes.pdf'), png = join(dir, 'shot.png'), md = join(dir, 'notes.md'), list = join(dir, 'rows.json')
writeFileSync(pdf, '%PDF-1.4 fixture'); writeFileSync(png, 'png bytes'); writeFileSync(md, '# shared note\n'); writeFileSync(list, '[1, 2]\n')
const envelope = '[附件] notes.pdf (application/pdf)\n[Size] 16\n[Kind] file'

function setup(options: { publish?: ReturnType<typeof vi.fn> } = {}) {
  const uploads: Array<Record<string, unknown>> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) {
      uploads.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    }
    if (url === 'https://oss.test/') return new Response(null, { status: 204 })
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id, content: '[附件] shot.png (image/png)\n[Size] 9\n[Kind] image' } }))
  }) as typeof globalThis.fetch
  const deps: Record<string, unknown> = {
    restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    restInsert: async () => { throw new Error('a file card is never a direct insert') },
    restRpc: async (name: string) => name === 'chat_facts' ? [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      : name === 'list_member_ids' ? [{ user_id: 'agent-1', role: 'member' }] : null,
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  const context = { supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null, guguHome: dir,
    getAccessToken: async () => 'token', ...(options.publish ? { publishFile: options.publish } : {}) }
  return { send: (args: Record<string, unknown>) => callToolImpl(context, 'message_send_file', { chat_id: CHAT, ...args }, deps), uploads }
}

describe('message_send_file in a project chat', () => {
  test('a file other than an image goes through this machine\'s publisher with its message, and no byte is uploaded', async () => {
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

  test('an image is uploaded when sent, with its type', async () => {
    const publish = vi.fn()
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: png }))).toMatchObject({ status: 'sent', file_name: 'shot.png' })
    expect(publish).not.toHaveBeenCalled()
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'image/png' })])
  })

  test('a text file the shared classifier makes a document is uploaded for the server to make it one, not published here', async () => {
    const publish = vi.fn()
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: md }))).toMatchObject({ status: 'sent', file_name: 'notes.md' })
    expect(publish).not.toHaveBeenCalled()
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'text/markdown' })])
  })

  test('JSON that is not an object stays stored bytes and is published here', async () => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>) => ({ message: { id: message.message_id, chat_id: CHAT, content: envelope } }))
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: list }))).toMatchObject({ status: 'sent' })
    expect(publish).toHaveBeenCalledOnce()
    expect(uploads).toEqual([])
  })

  test('the publisher declines (not a project chat, or this account uploads its files): the ordinary upload sends it', async () => {
    const { send, uploads } = setup({ publish: vi.fn(async () => null) })
    expect(JSON.parse(await send({ file_path: pdf }))).toMatchObject({ status: 'sent', file_name: 'notes.pdf' })
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'application/pdf' })])
  })

  // #719: the next version of a folder file, sent by an agent: published on its own machine, from the version named.
  const ITEM = '00000000-0000-4000-8000-0000000000aa'
  test.each([['a document', pdf, 'notes.pdf'], ['an image', png, 'shot.png']])('%s\'s next version is published on this machine, from the version named', async (_kind, path, name) => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>, _next?: unknown) =>
      ({ message: { id: message.message_id, chat_id: CHAT, content: envelope, file_item_id: ITEM, file_version: 3 } }))
    const { send, uploads } = setup({ publish })
    const receipt = JSON.parse(await send({ file: `gugu-file://${ITEM}?v=2`, file_path: path }))
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![1]).toMatchObject({ name, path })
    expect(publish.mock.calls[0]![4]).toEqual({ itemId: ITEM, expectedVersion: 2 })
    expect(uploads).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', version: 3, file: `gugu-file://${ITEM}?v=3` })
  })

  test('someone stored a newer version first: nothing was sent, and what to do', async () => {
    const { send } = setup({ publish: vi.fn(async () => { throw new Error('File revision conflict') }) })
    const error = await send({ file: `gugu-file://${ITEM}?v=2`, file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain(`someone stored a newer version of gugu-file://${ITEM}?v=2 since version 2, and nothing was sent`)
  })
})
