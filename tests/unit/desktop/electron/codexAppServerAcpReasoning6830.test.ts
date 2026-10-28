import { observeCodexForegroundCompletion } from '../../../support/codexForegroundCompletion';
// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// #6830 —— Codex 的思考在桌面上要画出来,活着和重开都要。
//
// 两种真机形状(mac1 实测):GPT-5.6 Terra 的思考不流增量,整条只出现在 `item/completed` 里(摘要有字、原文空);
// GLM 流 `item/reasoning/textDelta`,条目里摘要空、原文有字。历史 `thread/turns/list` 两种条目都带。
// 假 app-server 站在 codex 的位置,按这两种形状放出一轮,再按同样的条目回历史。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const THREAD = 'th-6830'
const TERRA = { type: 'reasoning', id: 'rs-terra', summary: ['**Timing the trip**', 'Moving time is 202.'], content: [] }
const GLM = { type: 'reasoning', id: 'rs-glm', summary: [], content: ['We need execute.'] }
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'turn/start' || m.method === 'turn/steer') process.stdout.write(JSON.stringify({ method: 'item/started', params: { item: { type: 'userMessage', id: 'user-' + m.id, clientId: m.params.clientUserMessageId, content: m.params.input } } }) + '\\n')
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start' || m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: THREAD }, model: 'm' } })
  if (m.method === 'thread/turns/list') {
    const items = [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Q' }] }, TERRA, GLM, { type: 'agentMessage', id: 'a1', text: '202' }]
    return out({ id: m.id, result: { data: [{ id: 'turn-old', items }], nextCursor: null } })
  }
  if (m.method === 'turn/start') {
    const turnId = 'turn-1'
    const item = (method, item) => out({ method, params: { threadId: THREAD, turnId, item } })
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } } })
    if (JSON.stringify(m.params.input).includes('RETRY_THEN_FAIL')) {
      const error = { message: 'Reconnecting... 1/7', additionalDetails: 'fixture upstream unavailable sk-fixture-secret-abcdefghijklmnopqrstuvwxyz' }
      out({ method: 'error', params: { threadId: 'child-thread', turnId, willRetry: true, error: { message: 'child retry' } } })
      out({ method: 'error', params: { threadId: THREAD, turnId, willRetry: true, error } })
      const finalError = { message: 'fixture upstream exhausted', codexErrorInfo: 'internalServerError' }
      out({ method: 'error', params: { threadId: THREAD, turnId, willRetry: false, error: finalError } })
      return out({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: turnId, status: 'failed', error: finalError } } })
    }
    if (JSON.stringify(m.params.input).includes('INTERLEAVED_CHILDREN')) {
      const notify = (method, params) => out({ method, params })
      const rootDelta = (delta) => notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'parent-message', delta })
      rootDelta('Parent before.')
      // #7586: one child's table and another child's reasoning used to alternate in the parent UI.
      for (const [delta, thought] of [['| 基础运行 |', '**Considering auditing permissions**'], ['授权 |', 'I should send my findings separately']]) {
        notify('item/agentMessage/delta', { threadId: 'child-audit', turnId: 'child-turn-a', itemId: 'child-message', delta })
        notify('item/reasoning/summaryTextDelta', { threadId: 'child-interaction', turnId: 'child-turn-b', itemId: 'child-reasoning', summaryIndex: 0, delta: thought })
      }
      notify('item/reasoning/textDelta', { threadId: 'child-audit', itemId: 'child-raw', delta: 'child raw reasoning' })
      notify('item/plan/delta', { threadId: 'child-audit', delta: 'child plan' })
      for (const childItem of [
        { type: 'agentMessage', id: 'child-whole-message', text: 'child final answer' },
        { type: 'reasoning', id: 'child-whole-reasoning', summary: ['child whole reasoning'], content: [] },
        { type: 'commandExecution', id: 'child-tool', command: 'child command', status: 'completed', aggregatedOutput: 'child output' },
        { type: 'contextCompaction', id: 'child-compaction' },
      ]) {
        for (const method of ['item/started', 'item/completed']) notify(method, { threadId: 'child-audit', turnId: 'child-turn-a', item: childItem })
      }
      notify('thread/tokenUsage/updated', { threadId: 'child-audit', tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 999 } } })
      notify('turn/completed', { threadId: 'child-audit', turn: { id: 'child-turn-a', status: 'completed' } })
      rootDelta('Parent after.')
      notify('thread/tokenUsage/updated', { threadId: THREAD, tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 123 } } })
    }
    item('item/started', TERRA)
    item('item/completed', TERRA)
    item('item/started', { ...GLM, content: [] })
    for (const delta of ['We need ', 'execute.']) out({ method: 'item/reasoning/textDelta', params: { threadId: THREAD, turnId, itemId: GLM.id, delta } })
    item('item/completed', GLM)
    // 摘要分节流:每节带自己的节号,节与节之间要空一行(否则两节的加粗标题粘成「…format****Counting…」)。
    for (const [summaryIndex, delta] of [[0, '**Planning**'], [0, ' the reply.'], [1, '**Counting**']]) {
      out({ method: 'item/reasoning/summaryTextDelta', params: { threadId: THREAD, turnId, itemId: 'rs-parts', summaryIndex, delta } })
    }
    item('item/completed', { type: 'reasoning', id: 'rs-parts', summary: ['**Planning** the reply.', '**Counting**'], content: [] })
    item('item/completed', { type: 'agentMessage', id: 'a2', text: 'DONE' })
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

async function start() {
  const raw = join(tmpdir(), `codex-reasoning-6830-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, unknown>()
  const updates: SessionUpdate[] = []
  const thoughts: Array<{ text: string; messageId?: string }> = []
  createInterface({ input: child.stdout }).on('line', observeCodexForegroundCompletion((line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    const update = m.method === 'session/update' ? m.params?.update : null
    if (update) updates.push(update)
    if (update?.sessionUpdate === 'agent_thought_chunk') {
      thoughts.push({ text: update.content.text, ...(update.messageId ? { messageId: update.messageId } : {}) })
    }
  }))
  let nextId = 1
  const call = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  }
  await call('initialize', { protocolVersion: 2, capabilities: {} })
  return { call, thoughts, updates }
}

describe('#6830 codex ACP bridge: reasoning reaches the desktop', () => {
  it('reports the native retry count and sanitized cause as a notice, then rejects with the final cause', async () => {
    const { call, updates } = await start()
    await call('session/new', { cwd: dir, mcpServers: [] })
    updates.length = 0
    expect(await call('session/prompt', { sessionId: 'th-6830', prompt: [{ type: 'text', text: 'RETRY_THEN_FAIL' }] }))
      .toMatchObject({ code: -32603, message: 'fixture upstream exhausted' })
    const notices = updates.filter((update) => update.sessionUpdate === 'notice')
    expect(notices).toEqual([{
      sessionUpdate: 'notice', severity: 'warning',
      title: 'Reconnecting... 1/7: fixture upstream unavailable [REDACTED_OPENAI_KEY]',
    }])
    expect(JSON.stringify(updates)).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(JSON.stringify(updates)).not.toContain('child retry')
  })

  it('#7586: concurrent child messages, reasoning, tools and lifecycle never enter the parent stream', async () => {
    const { call, thoughts, updates } = await start()
    await call('session/new', { cwd: dir, mcpServers: [] })
    updates.length = 0
    expect(await call('session/prompt', { sessionId: 'th-6830', prompt: [{ type: 'text', text: 'INTERLEAVED_CHILDREN' }] }))
      .toEqual({ stopReason: 'end_turn' })
    const messages = updates.flatMap((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])
    expect(messages).toEqual(['Parent before.', 'Parent after.', 'DONE'])
    expect(thoughts.map((thought) => thought.text).join('')).toBe('**Timing the trip**\n\nMoving time is 202.We need execute.**Planning** the reply.\n\n**Counting**')
    expect(updates.filter((update) => update.sessionUpdate === 'usage_update'))
      .toEqual([{ sessionUpdate: 'usage_update', used: 123, size: 1000 }])
    expect(updates.map((update) => update.sessionUpdate)).not.toContain('tool_call')
    expect(updates.map((update) => update.sessionUpdate)).not.toContain('tool_call_update')
    expect(JSON.stringify(updates)).not.toContain('child')
  })

  it('live: a reasoning item that streamed nothing is sent whole on completion; a streamed one is not sent twice, its summary parts a blank line apart', async () => {
    const { call, thoughts } = await start()
    await call('session/new', { cwd: dir, mcpServers: [] })
    await call('session/prompt', { sessionId: 'th-6830', prompt: [{ type: 'text', text: 'go' }] })
    expect(thoughts).toEqual([
      { text: '**Timing the trip**\n\nMoving time is 202.', messageId: 'rs-terra' },
      { text: 'We need ', messageId: 'rs-glm' },
      { text: 'execute.', messageId: 'rs-glm' },
      { text: '**Planning**', messageId: 'rs-parts' },
      { text: ' the reply.', messageId: 'rs-parts' },
      { text: '\n\n**Counting**', messageId: 'rs-parts' },
    ])
  })

  it('reopen: history replays both reasoning shapes, summary first, raw text when there is no summary', async () => {
    const { call, thoughts } = await start()
    await call('session/resume', { sessionId: 'th-6830', cwd: dir, mcpServers: [] })
    expect(thoughts).toEqual([
      { text: '**Timing the trip**\n\nMoving time is 202.', messageId: 'rs-terra' },
      { text: 'We need execute.', messageId: 'rs-glm' },
    ])
  })
})
