// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AcpTranscriptParser } from '@gugu/session-core/acp'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// A message inserted mid-turn is steered into the running Codex turn, so codex's history keeps it inside
// that turn's items. Reopen must rebuild the same turns the live session had: one native turn, one turn.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const user = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: 'th-steer' }, model: 'm' } })
  if (m.method === 'thread/turns/list') {
    return out({ id: m.id, result: { nextCursor: null, data: [
      { id: 'turn-2', items: [
        user('u2', 'run the long job'),
        { type: 'commandExecution', id: 'c1', command: 'sleep 5', status: 'completed', aggregatedOutput: '' },
        user('u3', 'also print pwd'),
        { type: 'agentMessage', id: 'a2', text: 'done, /tmp' },
      ] },
      { id: 'turn-1', items: [user('u1', 'hi'), { type: 'agentMessage', id: 'a1', text: 'hello' }] },
    ] } })
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
    const userTexts = turns.map((turn) => turn.items.flatMap((item) => (item.kind === 'message' && item.role === 'user' ? [item.text] : [])))
    expect(userTexts).toEqual([['hi'], ['run the long job', 'also print pwd']])
  })
})
