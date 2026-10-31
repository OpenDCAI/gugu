// message_send_file in a project chat that keeps files on its machine: on that machine a file other than an image is published
// by the host's own publisher (the composer's) and stays there; an image is uploaded when sent; a folder file's next version,
// an image's too, is published there from the version named; elsewhere the refusal says why.
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
    expect(error.message).toContain('notes.pdf was not sent, and nothing was changed')
    expect(error.message).toContain('on Ming\'s computer, and only an agent on that computer can add or change them')
    expect(error.message).toContain('存在Ming 的电脑上')
    expect(error.message).not.toMatch(/not uploaded proactively|published by the host|Settings/)
  })

  // #719: the next version of a folder file, sent by an agent on the host. It used to skip the host publisher, take the
  // cloud upload and be told to send it "from that machine" — the machine it was on.
  const ITEM = '00000000-0000-4000-8000-0000000000aa'
  test.each([['a document', pdf, 'notes.pdf'], ['an image', png, 'shot.png']])('on the host %s\'s next version is published there, from the version named', async (_kind, path, name) => {
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

  test('the host publisher refuses (another machine is the host): the refusal is said for people', async () => {
    const { send, uploads } = setup({ publish: vi.fn(async () => { throw new Error('Only the bound file host can publish project files') }) })
    const error = await send({ file: `gugu-file://${ITEM}?v=2`, file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain('notes.pdf was not sent, and nothing was changed')
    expect(error.message).not.toContain('bound file host')
    expect(uploads).toEqual([])
  })

  test('someone stored a newer version on the host first: nothing was sent, and what to do', async () => {
    const { send } = setup({ publish: vi.fn(async () => { throw new Error('File revision conflict') }) })
    const error = await send({ file: `gugu-file://${ITEM}?v=2`, file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain(`someone stored a newer version of gugu-file://${ITEM}?v=2 since version 2, and nothing was sent`)
  })

  // #791: the publisher hands a next version to the machine that keeps the file; when that machine did not write it, the
  // refusal names the machine, says the copy is still where it was, and what to do.
  test.each([
    ['host_offline', 'is offline', '它现在离线'],
    ['timeout', 'did not take the new version in time', '它没有及时收下新版本'],
  ])('the host did not write it (%s): which machine, the copy is still there, what to do', async (status, en, zh) => {
    const { NextVersionHandoffRefused } = await import('@gugu/core/cloud/fileVersionHandoff')
    const { send, uploads } = setup({ publish: vi.fn(async () => { throw new NextVersionHandoffRefused({ status: status as 'timeout', host_label: 'Studio Mac', host_account_id: 'owner-1' }) }) })
    const error = await send({ file: `gugu-file://${ITEM}?v=2`, file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain(`notes.pdf was not sent, and nothing was changed: "Studio Mac" (Ming's computer) keeps this project chat's files and ${en}. Your changed copy is still at ${pdf}.`)
    expect(error.message).toContain(`Send it again with file gugu-file://${ITEM}?v=2 once that computer is online, or ask an agent on that computer to make the change.`)
    expect(error.message).toContain(`「Studio Mac」（Ming 的电脑）上，${zh}`)
    expect(error.message).not.toMatch(/Settings|handoff/i)
    expect(uploads).toEqual([])
  })
})
