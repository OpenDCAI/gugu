import { observeCodexForegroundCompletion } from '../../../support/codexForegroundCompletion';
// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// 148 10-14 (旁观的活画面, step 0 on mac1): an MCP tool's result reaches the client as ACP `content` blocks from the
// Claude bridge — its pictures as `{ type: 'content', content: { type: 'image', … } }` — but the Codex bridge sent only the
// provider's own `rawOutput`, so a card had nowhere standard to read a tool's pictures from. Now the Codex bridge sends the
// result's blocks as ACP content too (MCP's content blocks are ACP's). Like the Claude bridge, the output travels once
// (review 10f3ea946c): a result those blocks carry whole is not sent again as `rawOutput`; one with more in it is. A fake
// app-server stands where codex is and completes one MCP tool item per prompt.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const THREAD = 'th-content'
const PICTURES = {
  content: [
    { type: 'text', text: 'It loaded without errors.' },
    { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
  ],
  structuredContent: null,
}
const STRUCTURED = { ...PICTURES, structuredContent: { ok: true } }
const LINKED = { content: [{ type: 'resource_link', uri: 'file:///work/report.md', name: 'report.md' }], structuredContent: null }
const SCRIPTS = {
  PICTURES: { status: 'completed', result: PICTURES },
  STRUCTURED: { status: 'completed', result: STRUCTURED },
  LINKED: { status: 'completed', result: LINKED },
  FAILED: { status: 'failed', error: { message: 'no such tab' } },
}
let turnSeq = 0
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'turn/start' || m.method === 'turn/steer') process.stdout.write(JSON.stringify({ method: 'item/started', params: { item: { type: 'userMessage', id: 'user-' + m.id, content: m.params.input } } }) + '\\n')
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: THREAD }, model: 'm' } })
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq)
    const text = JSON.stringify(m.params.input ?? '')
    const key = Object.keys(SCRIPTS).find((k) => text.includes(k))
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } } })
    const item = { type: 'mcpToolCall', id: turnId + '-tool', server: 'gugu', tool: 'catalog_call', arguments: { tool: 'app_check' }, ...SCRIPTS[key] }
    out({ method: 'item/completed', params: { threadId: THREAD, turnId, item } })
    out({ method: 'item/completed', params: { threadId: THREAD, turnId, item: { type: 'agentMessage', id: turnId + '-msg', text: 'DONE' } } })
    return out({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: turnId, status: 'completed' } } })
  }
  out({ id: m.id, result: { data: [] } })
})
`

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  const child = adapter
  adapter = null
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await exited
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

type ToolUpdate = { sessionUpdate: string; toolCallId: string; content?: unknown; rawOutput?: unknown }

/** One prompt through the bridge: the tool-call updates it sent for that turn. */
async function toolUpdates(script: string): Promise<ToolUpdate[]> {
  const raw = join(tmpdir(), `codex-tool-content-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const child = spawn(process.execPath, [ADAPTER], { cwd: dir, env: { ...process.env, GUGU_CODEX_BIN: fake }, stdio: ['pipe', 'pipe', 'pipe'] })
  adapter = child
  const responses = new Map<number, { result?: unknown; error?: unknown }>()
  const updates: ToolUpdate[] = []
  createInterface({ input: child.stdout }).on('line', observeCodexForegroundCompletion((line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, { result: m.result, error: m.error })
    const update = m.method === 'session/update' ? m.params?.update : undefined
    if (update?.toolCallId) updates.push(update)
  }))
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const reply = (id: number, what: string) => awaitFact(what, () => responses.get(id), { producer: child })
  await reply(send('initialize', { protocolVersion: 2, capabilities: {} }), 'initialize')
  const created = (await reply(send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')).result as { sessionId: string }
  await reply(send('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: script }] }), `${script} settles`)
  return updates
}

describe('codex ACP bridge: an MCP tool result reaches the client as ACP content (148 10-14)', () => {
  it('its text and its pictures come as content blocks, the way the Claude bridge sends them — and only there', async () => {
    const [update] = await toolUpdates('PICTURES')
    expect(update).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'turn-1-tool' })
    expect(update!.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'It loaded without errors.' } },
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' } },
    ])
    expect(update).not.toHaveProperty('rawOutput')
  })

  it('a result with more than its blocks (structuredContent) is also sent whole as rawOutput, so nothing is hidden', async () => {
    const [update] = await toolUpdates('STRUCTURED')
    expect(update!.content).toHaveLength(2)
    expect(update!.rawOutput).toEqual({
      content: [{ type: 'text', text: 'It loaded without errors.' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }],
      structuredContent: { ok: true },
    })
  })

  // Review 3b0e55360c: the client reads text and image blocks only; a resource_link (or resource, audio) alone would
  // leave the card with nothing to show, so such a result is also sent whole.
  it('a result with a block the client does not read (resource_link) is also sent whole as rawOutput', async () => {
    const [update] = await toolUpdates('LINKED')
    expect(update!.content).toEqual([{ type: 'content', content: { type: 'resource_link', uri: 'file:///work/report.md', name: 'report.md' } }])
    expect(update!.rawOutput).toEqual({
      content: [{ type: 'resource_link', uri: 'file:///work/report.md', name: 'report.md' }],
      structuredContent: null,
    })
  })

  it('a failed call has no result to show: no content, its error as rawOutput, as before', async () => {
    const [update] = await toolUpdates('FAILED')
    expect(update).not.toHaveProperty('content')
    expect(update!.rawOutput).toEqual({ message: 'no such tab' })
  })
})
