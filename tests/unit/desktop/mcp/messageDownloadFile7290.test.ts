// #7290 message_download_file { source_message_id }:host 读那条消息、按 agent 本人判看不看得见,字节从哪来由消息说 ——
// 老消息正文里的公开 URL,新消息指向群文件夹的那一版(attachments/urls 以 agent 的身份签)。存到本机,文件名按内容。
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { attachmentDownloadName } from '../../../../packages/core/src/shared/attachmentDownloadName.mjs'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const LEGACY_URL = 'https://db.test/storage/v1/object/public/chat-media/u/notes.pdf'
const legacy = `[附件] notes.pdf (application/pdf)\n[URL] ${LEGACY_URL}\n[Size] 5\n[Kind] file`
const envelope = '[附件] deck.pdf (application/pdf)\n[Size] 5\n[Kind] file'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })

async function setup(message: Record<string, unknown> | null, opts: { agentSees?: boolean; signed?: boolean; bytes?: Buffer } = {}) {
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
      // #84 agent 看不见时,会再问一句这条线是不是主人与好友的私聊(这里是群,不是 → 照旧拒)。
      if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: 'group', source_chat_id: null, group_prompt: null }]
      expect([name, body]).toEqual(['can_read_message', { p_message_id: 'm1', p_user_id: AGENT }])
      return opts.agentSees ?? true
    },
    attachmentUrls: async (refs: Array<Record<string, unknown>>) => {
      asked.push(refs)
      if (opts.signed === false) return { urls: [] }
      return { urls: refs.map((ref) => ({ ...ref, url: 'https://cdn.test/ab/sha?auth_key=k', thumb_url: null, sha256: 'ab'.repeat(32), width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })) }
    },
    fetchBytes: async (url: string) => { fetched.push(url); return opts.bytes ?? Buffer.from('bytes') },
  }
  const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token', guguHome: home, threadRootId: null }
  const call = () => callTool(context, 'message_download_file', { source_message_id: 'msg:m1' }, deps)
  return { call, asked, fetched, home }
}

describe('message_download_file by source_message_id (#7290)', () => {
  test('makes Windows punctuation and trailing dots or spaces portable without losing Chinese', () => {
    expect(attachmentDownloadName('报告 10:30<>"|?*.html. ')).toBe('报告 10_30______.html')
  })

  test.each(['CON', 'nul.html', 'COM1.txt', 'LPT9', 'COM¹.log'])('escapes reserved Windows device name %s', name => {
    expect(attachmentDownloadName(name)).toBe('_' + name)
  })

  test('limits UTF-8 bytes without splitting Unicode and retains the extension', () => {
    const name = attachmentDownloadName('核对🍵'.repeat(100) + '.html')
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200)
    expect(name.endsWith('.html')).toBe(true)
    expect(name).not.toContain('�')
    expect(name).toMatch(/^(?:核对🍵)*(?:核对|核)?\.html$/u)
  })

  test('old message: downloads its public URL; saved under a name taken from the content', async () => {
    const { call, fetched, asked, home } = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null })
    const text = JSON.stringify(await call())
    expect(fetched).toEqual([LEGACY_URL])
    expect(asked).toEqual([])
    const [name] = await readdir(join(home, 'chat-media'))
    expect(name).toBe(createHash('sha256').update('bytes').digest('hex'))
    expect(await readFile(join(home, 'chat-media', name!, 'notes.pdf'), 'utf8')).toBe('bytes')
    expect(text).toContain(join(home, 'chat-media', name!))
  })

  test('preserves a Chinese filename inside its hash directory, so default sending keeps the original name', async () => {
    const fileName = '费用核对报告（最终版）😀.html'
    const { call } = await setup({ id: 'm1', chat_id: CHAT, content: legacy.replace('notes.pdf', fileName), content_type: 'attachment', file_item_id: null, file_version: null })
    const receipt = JSON.parse(await call())
    expect(basename(receipt.file_path)).toBe(fileName)
    expect(basename(dirname(receipt.file_path))).toBe(receipt.sha256)
    expect(await readFile(receipt.file_path, 'utf8')).toBe('bytes')
    expect(attachmentDownloadName('../目录\\报告\u0000\u0085.html')).toBe('..目录报告.html')
    expect(attachmentDownloadName('..')).toBe('attachment')
  })

  test('returns full SHA-256 and actual byte count for the original bytes, including binary and Unicode data', async () => {
    const bytes = Buffer.concat([Buffer.from('原文件😀\n'), Buffer.from([0, 255, 13, 10, 128])])
    const content = legacy.replace('[Size] 5', `[Size] ${bytes.length}`)
    const { call } = await setup({ id: 'm1', chat_id: CHAT, content, content_type: 'attachment', file_item_id: null, file_version: null }, { bytes })
    const receipt = JSON.parse(await call())
    expect(receipt).toMatchObject({ file_name: 'notes.pdf', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(receipt.sha256).toHaveLength(64)
    expect(await readFile(receipt.file_path)).toEqual(bytes)
  })

  test('session-attachment tool receipt contains the verified original SHA and byte count', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-session-tool-receipt-')); homes.push(home)
    const bytes = new Uint8Array([0, 255, 65, 13, 10, 128, 9])
    const ref = { attachment_id: '44444444-4444-4444-8444-444444444444', file_name: '原始文件😀.bin', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_type: 'application/octet-stream' }
    const context = { agentId: AGENT, supabaseUrl: 'https://db.test', anonKey: 'anon', getAccessToken: async () => 'owner-token', guguHome: home, threadRootId: null }
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/session-urls')) {
        expect(JSON.parse(String(init?.body))).toEqual({ attachment_ids: [ref.attachment_id], as: AGENT })
        return Response.json({ attachments: [{ ...ref, url: 'https://objects.test/original', expires_at: '2999-01-01T00:00:00Z' }] })
      }
      expect(url).toBe('https://objects.test/original'); return new Response(bytes)
    }
    const receipt = JSON.parse(await callTool(context, 'message_download_file', { source_attachment_id: ref.attachment_id }, { fetch }))
    expect(receipt).toMatchObject(ref)
    expect(basename(receipt.file_path)).toBe(ref.file_name)
    expect(basename(dirname(receipt.file_path))).toBe(ref.sha256)
    expect(new Uint8Array(await readFile(receipt.file_path))).toEqual(bytes)
    expect(receipt).not.toHaveProperty('url')
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
