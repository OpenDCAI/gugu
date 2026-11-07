import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, expect, it, vi } from 'vitest'
import { conversationLink, groupFileLink } from '@gugu/core/shared/ui/guguLink'
import { privateServicePermissionDirectory } from '@gugu/core/local/state/agentFileBoundary'
import { sendReceipt } from '../../../../packages/session-core/src/session-record/send-receipt'
import { GuguMcpHost } from '../../../../apps/desktop/electron/gugu-mcp-host'
import { PrivatePermissionRecords } from '../../../../apps/desktop/electron/permissions/private-records'
import { ServicePermissionRuntime } from '../../../../apps/desktop/electron/permissions/runtime'
// @ts-expect-error The production MCP server is an injectable JavaScript module.
import { createGuguImServer, serveToolsList } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const message = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const file = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

it('keeps URI file sends behind the native private-file boundary through authenticated HTTP MCP', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gugu-resource-file-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('GUGU_HOME', home)
  const privateDirectory = privateServicePermissionDirectory()
  await mkdir(privateDirectory, { recursive: true })
  const ordinary = join(home, 'document.txt')
  const denied = join(privateDirectory, 'fixture.jsonl')
  await writeFile(ordinary, 'ordinary fixture bytes')
  await writeFile(denied, 'private fixture canary')
  const publishFile = vi.fn(async (_chat: string, upload: { path: string }) => {
    expect(await readFile(upload.path, 'utf8')).toBe('ordinary fixture bytes')
    return { message: { id: message, file_item_id: file, file_version: 2 } }
  })
  const context = { agentId: agent, guguHome: home, getAccessToken: async () => '', threadRootId: null, publishFile }
  const restRpc = vi.fn(async (name: string, args: { p_chat_id: string }) => {
    expect(args.p_chat_id).toBe(chat)
    if (name === 'chat_facts') return [{ id: chat, kind: 'group', group_prompt: null }]
    if (name === 'list_member_ids') return [{ user_id: agent }]
    throw new Error(`Unexpected RPC: ${name}`)
  })
  const restGet = vi.fn(async (path: string) => {
    if (path.startsWith('message_agent_delivery_blocks?')) return []
    throw new Error(`Unexpected REST read: ${path}`)
  })
  // Observation mode is the existing default; no account, cloud policy or model is involved.
  // The actual native private-file boundary remains active independently of that rollout.
  const permissions = new ServicePermissionRuntime({
    records: new PrivatePermissionRecords(privateDirectory), readPolicy: async () => null,
  })
  const host = new GuguMcpHost(() => {
    const server = createGuguImServer(() => context, { restRpc, restGet, trackRequest: <T>(work: Promise<T>) => work })
    serveToolsList(server, () => context)
    return server
  }, () => ({ ownerId: 'fixture-owner', subjectId: agent, toolScope: 'gugu' }), undefined, permissions)
  cleanup.push(() => host.dispose())
  await host.start()
  const grant = await host.grant('resource-file-fixture', null)
  const client = new Client({ name: 'resource-file-consumer', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  expect((await client.listTools()).tools.some(tool => tool.name === 'message_send_file')).toBe(true)
  // The legacy chat spelling is a control for both the publisher and its refusal path.
  for (const chat_id of [chat, conversationLink(chat)]) {
    const args = { chat_id, file: groupFileLink(file, { version: 1 }), to_user_ids: [`user:${agent}`] }
    const before = publishFile.mock.calls.length
    const accepted = await client.callTool({ name: 'message_send_file', arguments: { ...args, file_path: ordinary } }) as CallToolResult
    expect(accepted.isError).not.toBe(true)
    const receiptText = accepted.content.find(block => block.type === 'text')?.text
    expect(JSON.parse(String(receiptText))).toMatchObject({
      status: 'sent', message_id: `msg:${message}`, file: groupFileLink(file, { version: 2 }),
      version: 2, source_link: conversationLink(chat, message),
    })
    expect(sendReceipt(accepted)?.message_id).toBe(`msg:${message}`)
    expect(publishFile).toHaveBeenCalledTimes(before + 1)
    expect(publishFile).toHaveBeenLastCalledWith(chat, expect.objectContaining({ path: ordinary }), agent,
      expect.objectContaining({ chat_id: chat }), { itemId: file, expectedVersion: 1 })
    const refused = await client.callTool({ name: 'message_send_file', arguments: { ...args, file_path: denied } })
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: 'error: Agent file access to private permission state is forbidden' }] })
    expect(JSON.stringify(refused)).not.toContain('private fixture canary')
    expect(publishFile).toHaveBeenCalledTimes(before + 1)
  }
})
