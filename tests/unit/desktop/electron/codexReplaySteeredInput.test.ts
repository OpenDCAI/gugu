// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpTranscriptParser } from '@gugu/session-core/acp'
import type { TranscriptTurn } from '../../../../packages/session-core/src/acp/models/turns/turn'
import { createCodexJsonlSource } from '../../../../packages/session-core/src/session-record/sources/codex-jsonl'
import { createSessionTimeline } from '../../../../packages/session-core/src/session-record/timeline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// A message inserted mid-turn is steered into the running Codex turn, so codex's history keeps it inside
// that turn's items. Reopen must rebuild the same turns the live session had: one native turn, one turn.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const ROLLOUT = resolve(__dirname, '../../../../packages/session-core/src/session-record/__fixtures__/codex-steered-rollout.jsonl')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
// Project the same rollout fixture into the app-server's turn/item API. The adapter still does the real replay.
const turns = []
for (const [index, line] of require('node:fs').readFileSync(${JSON.stringify(ROLLOUT)}, 'utf8').trim().split('\\n').entries()) {
  const { type, payload: p } = JSON.parse(line)
  if (type === 'event_msg' && p.type === 'task_started') turns.push({ id: p.turn_id, items: [] })
  if (type !== 'response_item') continue
  const items = turns.at(-1).items
  if (p.type === 'message') items.push(p.role === 'user'
    ? { type: 'userMessage', id: 'u' + index, content: p.content.map(c => ({ type: 'text', text: c.text })) }
    : { type: 'agentMessage', id: 'a' + index, text: p.content.map(c => c.text).join('\\n') })
  if (p.type === 'function_call') items.push({ type: 'mcpToolCall', id: p.call_id, server: p.namespace.slice(5), tool: p.name, arguments: JSON.parse(p.arguments), status: 'completed' })
  if (p.type === 'custom_tool_call') items.push({ type: 'dynamicToolCall', id: p.call_id, tool: p.name, arguments: p.input, status: 'completed' })
  if (p.type === 'function_call_output') items.find(i => i.id === p.call_id).result = { content: p.output.map(c => ({ type: 'text', text: c.text })) }
}
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: 'th-steer' }, model: 'm' } })
  if (m.method === 'thread/turns/list') {
    return out({ id: m.id, result: { nextCursor: null, data: [...turns].reverse() } })
  }
  out({ id: m.id, result: { data: [] } })
})
`

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null
const disposers: Array<() => void> = []

afterEach(async () => {
  while (disposers.length) disposers.pop()!()
  const child = adapter
  adapter = null
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await exited
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function expectNativeTurns(turns: readonly TranscriptTurn[]) {
  expect(turns.map(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.text] : [])))
    .toEqual([['hi'], ['run the long job', 'also print pwd']])
  expect(turns[1].items.filter(item => item.kind.endsWith('-tool-call'))).toEqual([
    expect.objectContaining({ kind: 'mcp-tool-call', server: 'gugu', tool: 'profile_whoami', status: 'done', outputText: 'profile result' }),
    expect.objectContaining({ kind: 'unknown-tool-call', name: 'exec', title: 'exec' }),
  ])
}

async function loadHistory(): Promise<SessionUpdate[]> {
  const raw = join(tmpdir(), `codex-replay-steer-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const child = spawn(process.execPath, [ADAPTER], { cwd: dir, env: { ...process.env, GUGU_CODEX_BIN: fake }, stdio: ['pipe', 'pipe', 'pipe'] })
  adapter = child
  const responses = new Map<number, unknown>()
  const updates: SessionUpdate[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    if (m.method === 'session/update' && m.params?.update) updates.push(m.params.update)
  })
  let nextId = 1
  const call = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  }
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  await call('session/load', { sessionId: 'th-steer', cwd: dir, mcpServers: [] })
  return updates
}

describe('codex reopen: a steered input stays in its native turn', () => {
  it('replays two native turns as two transcript turns, the inserted message inside the second', async () => {
    const updates = await loadHistory()
    const parser = new AcpTranscriptParser({ sessionId: 'th-steer' })
    parser.beginReplay(1)
    for (const update of updates) parser.push(update, 2)
    parser.endReplay(3)
    const turns = [...parser.history, ...(parser.activeTurn ? [parser.activeTurn] : [])]
    expectNativeTurns(turns)
  })

  it.each([false, true])('rebuilds the same rollout from the native source (resume mid-turn: %s)', async (resumeMidTurn) => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-native-steer-')))
    const file = join(dir, 'rollout-test-th-steer.jsonl')
    const lines = readFileSync(ROLLOUT, 'utf8').trim().split('\n')
    const cut = resumeMidTurn ? 7 : lines.length
    writeFileSync(file, lines.slice(0, cut).join('\n') + '\n')
    const locator = { harness: 'codex' as const, providerSessionId: 'th-steer', roots: [dir] }
    let timeline = await createSessionTimeline(createCodexJsonlSource(locator), { sessionId: 'th-steer' })
    disposers.push(() => timeline.dispose())
    if (resumeMidTurn) {
      const archive = await timeline.archive!()
      expect(archive).not.toBeNull()
      timeline.dispose()
      appendFileSync(file, lines.slice(cut).join('\n') + '\n')
      timeline = await createSessionTimeline(createCodexJsonlSource(locator), { sessionId: 'th-steer', archive: archive! })
    }
    expectNativeTurns(timeline.getSnapshot().turns)
  })
})
