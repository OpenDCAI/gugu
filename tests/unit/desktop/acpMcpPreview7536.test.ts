import { describe, expect, it } from 'vitest'
import { partialMcpInput } from '@agentclientprotocol/claude-agent-acp/dist/partial-mcp-input.js'
import { ClientCapabilities } from '@agentclientprotocol/claude-agent-acp/dist/tool-calls/client-capabilities.js'

/** Exercises the installed, lockfile-patched distribution, rather than a local candidate checkout. */
describe('the shipped ACP bridge previews MCP arguments (#7536)', () => {
  it('publishes actual growing text and waits for split escapes without guessing', () => {
    const call = 'mcp__gugu__message_send'
    expect(partialMcpInput(call, '{"chat_id":"chat","text":"你', true)).toEqual({ chat_id: 'chat', text: '你' })
    expect(partialMcpInput(call, '{"chat_id":"chat","text":"你好', true)).toEqual({ chat_id: 'chat', text: '你好' })
    expect(partialMcpInput(call, '{"text":"line\\', true)).toEqual({ text: 'line' })
    expect(partialMcpInput(call, '{"text":"line\\n', true)).toEqual({ text: 'line\n' })
    expect(partialMcpInput(call, '{"text":"\\u4f', true)).toBeUndefined()
    expect(partialMcpInput(call, '{"nested":{"text":"unfinished', true)).toBeUndefined()
    expect(partialMcpInput('Write', '{"content":"unfinished', true)).toBeUndefined()
  })
  it('requires the AIR client to explicitly opt into incremental argument previews', () => {
    const air = { _meta: { 'jetbrains': { air: {} } } }
    expect(ClientCapabilities.from(air).air.client).toBe(true)
    expect(ClientCapabilities.from(air).partialMcpInput).toBe(false)
    expect(ClientCapabilities.from({ ...air, _meta: { ...air._meta, 'gugu.mcp-input-preview': true } }).partialMcpInput).toBe(true)
  })
})
