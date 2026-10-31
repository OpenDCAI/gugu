import { observeCodexForegroundCompletion } from '../../../support/codexForegroundCompletion';
// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// #6628 —— 哪些咕咕工具出错会让这一轮结算成失败。
//
// 桥在 Codex 报 `completed` 时,若本轮记着一次咕咕工具失败,就把 ACP 的 session/prompt 回成 -32603
// ⇒ 会话页显示「Turn failed」。#4052 要防的是「回复被拒却像答完了」,所以只有回复工具(message_send)
// 失败才该这样;读类工具参数写错、经 catalog_call 调到的扩展工具报错,模型自己看得见、会改,和别的
// MCP server 上的工具一样只是普通工具结果。假 app-server 站在 codex 的位置,按提示里的记号放出这一轮的
// 工具项,再报 `completed`。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const THREAD = 'th-6628'
const failed = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })
const SCRIPTS = {
  CATALOG_EXT_ERROR: [['gugu', 'catalog_call', { result: failed('AX-FAIL') }]],
  NATIVE_RETRY: [
    ['gugu', 'session_list_harnesses', { status: 'failed', error: { message: 'rows must be a count like "20"' } }],
    ['gugu', 'session_list_harnesses', { result: ok('[]') }],
  ],
  REPLY_FAILED: [['gugu', 'message_send', { result: failed('chat not found') }]],
  REPLY_RETRY: [
    ['gugu', 'message_send', { result: failed('chat not found') }],
    ['gugu', 'message_send', { result: ok('{"sent":true}') }],
  ],
  OTHER_SERVER_ERROR: [['ax-probe', 'probe', { result: failed('AX-FAIL') }]],
}
let turnSeq = 0
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'turn/start' || m.method === 'turn/steer') process.stdout.write(JSON.stringify({ method: 'item/started', params: { item: { type: 'userMessage', id: 'user-' + m.id, clientId: m.params.clientUserMessageId, content: m.params.input } } }) + '\\n')
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: THREAD }, model: 'm' } })
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq)
    const text = JSON.stringify(m.params.input ?? '')
    const key = Object.keys(SCRIPTS).find((k) => text.includes(k))
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } } })
    ;(SCRIPTS[key] ?? []).forEach(([server, tool, end], i) => {
      const item = { type: 'mcpToolCall', id: turnId + '-item-' + i, server, tool, status: 'completed', ...end }
      out({ method: 'item/completed', params: { threadId: THREAD, turnId, item } })
    })
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

function start() {
  const raw = join(tmpdir(), `codex-tool-outcome-6628-${process.pid}-${Date.now()}`)
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
  const responses = new Map<number, { result?: unknown; error?: { code: number; message: string } }>()
  createInterface({ input: child.stdout }).on('line', observeCodexForegroundCompletion((line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, { result: m.result, error: m.error })
  }))
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const reply = (id: number, what: string) =>
    awaitFact(what, () => responses.get(id), { producer: child })
  return { send, reply }
}

async function turnOutcome(script: string) {
  const rig = start()
  await rig.reply(rig.send('initialize', { protocolVersion: 2, capabilities: {} }), 'initialize')
  const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')).result as { sessionId: string }
  expect(created.sessionId).toBe('th-6628')
  return rig.reply(rig.send('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: script }] }), `${script} settles`)
}

describe('#6628 codex ACP bridge: only a failed reply fails the turn', () => {
  it('an extension tool reached through catalog_call reports isError, the model answers: the turn ends normally', async () => {
    expect(await turnOutcome('CATALOG_EXT_ERROR')).toEqual({ result: { stopReason: 'end_turn' }, error: undefined })
  })

  it('a native Gugu read tool fails, the model retries it and answers: the turn ends normally', async () => {
    expect(await turnOutcome('NATIVE_RETRY')).toEqual({ result: { stopReason: 'end_turn' }, error: undefined })
  })

  it('the reply fails and is never retried: the turn still fails (#4052)', async () => {
    const outcome = await turnOutcome('REPLY_FAILED')
    expect(outcome.result).toBeUndefined()
    expect(outcome.error?.code).toBe(-32603)
    expect(outcome.error?.message).toContain('failed Gugu tool call: message_send')
    expect(outcome.error?.message).toContain('chat not found')
  })

  it('the reply fails, then a retry succeeds: the turn ends normally', async () => {
    expect(await turnOutcome('REPLY_RETRY')).toEqual({ result: { stopReason: 'end_turn' }, error: undefined })
  })

  it('control: an error from another MCP server never failed the turn', async () => {
    expect(await turnOutcome('OTHER_SERVER_ERROR')).toEqual({ result: { stopReason: 'end_turn' }, error: undefined })
  })
})
