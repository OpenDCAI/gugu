// message_send_file { file }:群文件夹里已有的文件按引用发成附件卡片(不传字节、不建条目);{ file, file_path }:改过的文件发成
// 它的下一版(?v= 是起点版本,服务端用它判冲突)。agent 在投递、历史和下载回执里读到的是同一个 gugu-file 链接。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { attachmentFolderLine } from '../../../../packages/core/src/shared/attachmentFolderLine'

const CHAT = '00000000-0000-4000-8000-000000000001'
const ITEM = '3f88423a-bbca-49f1-9d19-48bb6ee042a5'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const envelope = (size: number) => `[附件] GLM_Agent.pptx (${PPTX})\n[Size] ${size}\n[Kind] file`
const CONTEXT = {
  supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null,
  guguHome: '/tmp/gugu-send-by-reference-test', getAccessToken: async () => 'token',
}
const callTool = (name: string, args: Record<string, unknown>, deps: Record<string, unknown>) => callToolImpl(CONTEXT, name, args, deps)
const localFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-send-by-reference-'))
  const full = join(dir, 'GLM_Agent.pptx')
  writeFileSync(full, 'changed deck')
  return full
})()

function makeDeps(commitAnswer?: (args: Record<string, unknown>) => Response) {
  const rpcs: Array<[string, Record<string, unknown>]> = []
  const commits: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const shares: Array<Record<string, unknown>> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) return new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    if (url === 'https://oss.test/') { uploads.push(((init?.body as FormData).get('file') as File).name); return new Response(null, { status: 204 }) }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.endsWith('/attachments/share')) {
      shares.push(args)
      return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: CHAT, content: envelope(64941), content_type: 'attachment', file_item_id: args.item_id, file_version: args.version ?? 2 } }))
    }
    commits.push(args)
    return commitAnswer?.(args)
      ?? new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id, content: envelope(12), file_item_id: ITEM, file_version: 3 } }))
  }) as typeof globalThis.fetch
  const deps: Record<string, unknown> = {
    restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    restInsert: async () => { throw new Error('a file card is never a direct insert') },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      if (name === 'chat_facts') return [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') return [{ user_id: 'agent-1', role: 'member' }]
      return null
    },
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  return { deps, rpcs, commits, uploads, shares }
}

describe('message_send_file by reference', () => {
  test('file alone: one attachments/share call pinned to that version, no upload, no commit; the receipt names the pinned file', async () => {
    const { deps, shares, commits, uploads } = makeDeps()
    const receipt = JSON.parse(await callTool('message_send_file', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=1` }, deps))
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ item_id: ITEM, version: 1, chat_id: CHAT, sender_user_id: 'agent-1', to_user_ids: [] })
    expect(String(shares[0]!.message_id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(uploads).toEqual([])
    expect(commits).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'GLM_Agent.pptx', file: `gugu-file://${ITEM}?v=1`, version: 1 })
  })

  test('file without a version (or a bare item id) sends its current version', async () => {
    for (const file of [`gugu-file://${ITEM}`, ITEM]) {
      const { deps, shares } = makeDeps()
      const receipt = JSON.parse(await callTool('message_send_file', { chat_id: CHAT, file }, deps))
      expect(shares[0]).toMatchObject({ item_id: ITEM, version: null })
      expect(receipt.file).toBe(`gugu-file://${ITEM}?v=2`)
    }
  })

  test('file + file_path: the upload is committed as that file\'s next version from ?v=, the receipt pins the new version', async () => {
    const { deps, shares, commits, uploads } = makeDeps()
    const receipt = JSON.parse(await callTool('message_send_file', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=2`, file_path: localFile }, deps))
    expect(uploads).toEqual(['GLM_Agent.pptx'])
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ chat_id: CHAT, sender_user_id: 'agent-1', item_id: ITEM, expected_version: 2 })
    expect(shares).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file: `gugu-file://${ITEM}?v=3`, version: 3 })
  })

  test('keep: the commit carries how long the uploaded copy stays; not given, no keep is sent', async () => {
    const temporary = makeDeps()
    await callTool('message_send_file', { chat_id: CHAT, file_path: localFile, temporary: true }, temporary.deps)
    expect(temporary.commits[0]).toMatchObject({ keep: 'temporary' })
    const plain = makeDeps()
    await callTool('message_send_file', { chat_id: CHAT, file_path: localFile }, plain.deps)
    expect(plain.commits[0]).not.toHaveProperty('keep')
  })

  test('file_path alone: as before — a new file, no item_id in the commit', async () => {
    const { deps, commits } = makeDeps()
    await callTool('message_send_file', { chat_id: CHAT, file_path: localFile }, deps)
    expect(commits).toHaveLength(1)
    expect(commits[0]).not.toHaveProperty('item_id')
    expect(commits[0]).not.toHaveProperty('expected_version')
  })

  test('refused before any upload: a next version without the version it starts from; neither file nor file_path; a file that is not a folder link', async () => {
    const { deps, commits, uploads, shares } = makeDeps()
    await expect(callTool('message_send_file', { chat_id: CHAT, file: `gugu-file://${ITEM}`, file_path: localFile }, deps))
      .rejects.toThrow(`gugu-file://${ITEM}?v=<n>`)
    await expect(callTool('message_send_file', { chat_id: CHAT }, deps)).rejects.toThrow(/give file .*file_path/)
    await expect(callTool('message_send_file', { chat_id: CHAT, file: 'https://example.test/deck.pptx' }, deps)).rejects.toThrow(/gugu-file:\/\/<item_id>\?v=<n>/)
    expect(uploads).toEqual([])
    expect(commits).toEqual([])
    expect(shares).toEqual([])
  })

  test('a newer version stored since: says what to do and that nothing was sent', async () => {
    const { deps } = makeDeps(() => new Response(JSON.stringify({ error: 'version_conflict', message: 'workspace item x version conflict: expected 2, got 3' }), { status: 409 }))
    await expect(callTool('message_send_file', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=2`, file_path: localFile }, deps))
      .rejects.toThrow(/newer version .* since version 2, and nothing was sent/)
  })
})

describe('the folder file an agent reads', () => {
  test('history rows carry the pinned file as one link instead of two raw columns', async () => {
    const { deps } = makeDeps()
    const rows = [
      { id: 'm1', content: envelope(5), content_type: 'attachment', file_item_id: ITEM, file_version: 2 },
      { id: 'm2', content: 'hello', content_type: 'text', file_item_id: null, file_version: null },
    ]
    const restRpc = deps.restRpc as (name: string, body: Record<string, unknown>) => Promise<unknown>
    deps.restRpc = async (name: string, body: Record<string, unknown>) => (name === 'message_history_as' ? rows : restRpc(name, body))
    const read = JSON.parse(await callTool('message_history', { chat_id: CHAT }, deps))
    expect(read).toEqual([
      { id: 'msg:m1', content: envelope(5), content_type: 'attachment', file: `gugu-file://${ITEM}?v=2` },
      { id: 'msg:m2', content: 'hello', content_type: 'text' },
    ])
  })

  test('the line names the file, the call that shows it again and the call that sends a change as its next version', () => {
    const line = attachmentFolderLine(ITEM, 2)
    expect(line).toContain(`message_send_file {file: "gugu-file://${ITEM}?v=2"}`)
    expect(line).toContain(`message_send_file {file: "gugu-file://${ITEM}?v=2", file_path}`)
    expect(line).toMatch(/next version, never as a new attachment/)
  })
})
