import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GuguToolResult } from '../../../../apps/desktop/electron/mcp/register-gugu-tool.mjs'

const lines = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; message: string }>)
vi.mock('../../../../apps/desktop/electron/lib/logger', () => {
  const record = (fields: Record<string, unknown>, message: string) => { lines.push({ fields, message }) }
  const log = { info: record, warn: record, error: () => undefined, debug: () => undefined }
  return { createLogger: () => log }
})

const { GuguMcpHost } = await import('../../../../apps/desktop/electron/gugu-mcp-host')
const { registerGuguTool } = await import('../../../../apps/desktop/electron/mcp/register-gugu-tool.mjs')

interface Ctx { ownerId: string; subjectId: string; toolScope: string }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map((close) => close())); lines.length = 0 })

// The completion line separates promise settlement (outcome) from a native MCP error result (resultIsError),
// and names a thrown failure only by type — never its message.
it('logs a completion line for success, an isError result and a thrown failure', async () => {
  class SecretFailure extends Error { override name = 'SecretFailure' }
  const host = new GuguMcpHost<Ctx>((_getContext, _signal, track) => {
    const server = new McpServer({ name: 'completion-test', version: '1.0.0' })
    const tool = (name: string, run: () => Promise<GuguToolResult>) =>
      registerGuguTool(server, { name, description: `${name} probe.`, schema: z.object({}) }, run, track)
    tool('ok_tool', async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    tool('error_result_tool', async () => ({ content: [{ type: 'text' as const, text: 'no' }], isError: true }))
    tool('throwing_tool', async () => { throw new SecretFailure('payload must not be logged') })
    return server
  }, ({ ownerId, subjectId, toolScope }) => ({ ownerId, subjectId, toolScope }))
  cleanup.push(() => host.dispose())
  await host.start()
  const grant = await host.grant('alpha', { ownerId: 'owner-1', subjectId: 'agent-1', toolScope: 'gugu' })
  const client = new Client({ name: 'completion-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  })
  cleanup.push(() => client.close())
  await client.connect(transport)

  for (const name of ['ok_tool', 'error_result_tool', 'throwing_tool']) await client.callTool({ name, arguments: {} })
  await vi.waitFor(() => expect(lines.filter((line) => line.message === 'gugu MCP tool call completed')).toHaveLength(3))

  const byTool = Object.fromEntries(lines.map((line) => [line.fields.tool, line.fields]))
  const attribution = { mcpSessionId: transport.sessionId, toolScope: 'gugu', requestId: expect.anything() }
  expect(byTool.ok_tool).toMatchObject({ ...attribution, outcome: 'success', resultIsError: false })
  expect(byTool.error_result_tool).toMatchObject({ ...attribution, outcome: 'success', resultIsError: true })
  expect(byTool.throwing_tool).toMatchObject({ ...attribution, outcome: 'error', errorType: 'SecretFailure' })
  expect(byTool.ok_tool).not.toHaveProperty('errorType')
  expect(byTool.throwing_tool).not.toHaveProperty('resultIsError')
  expect(JSON.stringify(lines)).not.toContain('payload must not be logged')
})
