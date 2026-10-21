// #7290 message_download_file { source_message_id }:host 读那条消息、按 agent 本人判看不看得见,字节从哪来由消息说 ——
// 老消息正文里的公开 URL,新消息指向群文件夹的那一版(attachments/urls 以 agent 的身份签)。存到本机,文件名按内容。
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const LEGACY_URL = 'https://db.test/storage/v1/object/public/chat-media/u/notes.pdf'
const legacy = `[附件] notes.pdf (application/pdf)\n[URL] ${LEGACY_URL}\n[Size] 5\n[Kind] file`
const envelope = '[附件] deck.pdf (application/pdf)\n[Size] 5\n[Kind] file'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })

async function setup(message: Record<string, unknown> | null, opts: { agentSees?: boolean; signed?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'gugu-download-test-'))
  homes.push(home)
  const asked: unknown[] = []
  const fetched: string[] = []
  const deps = {
    restGet: async (path: string) => {
      expect(path).toContain('select=id,chat_id,content,content_type,file_item_id,file_version,file_blob_id')
      return message ? [message] : []
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      expect([name, body]).toEqual(['can_read_message', { p_message_id: 'm1', p_user_id: AGENT }])
      return opts.agentSees ?? true
    },
    attachmentUrls: async (refs: Array<Record<string, unknown>>) => {
      asked.push(refs)
      if (opts.signed === false) return { urls: [] }
      return { urls: refs.map((ref) => ({ ...ref, url: 'https://cdn.test/ab/sha?auth_key=k', thumb_url: null, sha256: 'ab'.repeat(32), width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })) }
    },
    fetchBytes: async (url: string) => { fetched.push(url); return Buffer.from('bytes') },
  }
  const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token', guguHome: home, threadRootId: null }
  const call = () => callTool(context, 'message_download_file', { source_message_id: 'msg:m1' }, deps)
  return { call, asked, fetched, home }
}

describe('message_download_file by source_message_id (#7290)', () => {
  test('old message: downloads its public URL; saved under a name taken from the content', async () => {
    const { call, fetched, asked, home } = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null })
    const text = JSON.stringify(await call())
    expect(fetched).toEqual([LEGACY_URL])
    expect(asked).toEqual([])
    const [name] = await readdir(join(home, 'chat-media'))
    expect(name).toBe(`${createHash('sha256').update('bytes').digest('hex').slice(0, 24)}-notes.pdf`)
    expect(await readFile(join(home, 'chat-media', name!), 'utf8')).toBe('bytes')
    expect(text).toContain(join(home, 'chat-media', name!))
  })

  test('folder-backed message: signs the pinned version as this agent, downloads the signed link', async () => {
    const { call, fetched, asked } = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3 })
    await call()
    expect(asked).toEqual([[{ item_id: 'item-1', version: 3 }]])
    expect(fetched).toEqual(['https://cdn.test/ab/sha?auth_key=k'])
  })

  // 复核 X2:真正发出去的 attachments/urls 请求里,`as` 是这个 agent(不是令牌的主人)。
  test('the attachments/urls request it sends signs as this agent (as = context.agentId)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-download-as-'))
    homes.push(home)
    const sent: Array<{ url: string; body: unknown }> = []
    const injected = {
      restGet: async () => [{ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3, file_blob_id: null }],
      restRpc: async () => true,
      fetch: async (url: string, init?: RequestInit) => {
        sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/functions/v1/attachments/urls')) {
          return new Response(JSON.stringify({ urls: [{ item_id: 'item-1', version: 3, url: 'https://cdn.test/ab/sha?auth_key=k', thumb_url: null, sha256: null, width: null, height: null, expires_at: '2999-01-01T00:00:00Z' }] }))
        }
        return new Response('bytes')
      },
    }
    const context = { agentId: AGENT, supabaseUrl: 'https://db.test', anonKey: 'anon', getAccessToken: async () => 'owner-token', guguHome: home, threadRootId: null }
    await callTool(context, 'message_download_file', { source_message_id: 'msg:m1' }, injected)
    expect(sent.map((one) => one.url)).toEqual(['https://db.test/functions/v1/attachments/urls', 'https://cdn.test/ab/sha?auth_key=k'])
    expect(sent[0]!.body).toEqual({ refs: [{ item_id: 'item-1', version: 3 }], as: AGENT })
  })

  test('whisper attachment (no folder item, the message points at the bytes): signed by its message id as this agent', async () => {
    const { call, fetched, asked } = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: null, file_version: null, file_blob_id: 'blob-1' })
    await call()
    expect(asked).toEqual([[{ message_id: 'm1' }]])
    expect(fetched).toEqual(['https://cdn.test/ab/sha?auth_key=k'])
  })

  test('refuses: a message the agent cannot see, one without an attachment, a deleted file, one it may no longer read', async () => {
    const hidden = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null }, { agentSees: false })
    await expect(hidden.call()).rejects.toThrow('there is no message m1 you can read')
    const text = await setup({ id: 'm1', chat_id: CHAT, content: 'hi', content_type: 'text', file_item_id: null, file_version: null })
    await expect(text.call()).rejects.toThrow('has no attachment')
    const gone = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: null, file_version: 3 })
    await expect(gone.call()).rejects.toThrow('was deleted from the group folder')
    expect(gone.fetched).toEqual([])
    const unsigned = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3 }, { signed: false })
    await expect(unsigned.call()).rejects.toThrow('no longer readable')
  })
})
