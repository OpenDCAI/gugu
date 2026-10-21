// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// 编辑重发时恰好收到一条消息,任务一直显示在工作(10-18 在 macOS 上实撞)。
//
// 两条 session/prompt 几乎同时进桥:两条都还没看见在跑的轮,都发了 turn/start。codex 的 turn/start 遇到在跑的轮
// 不另开,而是插进去、回那一轮的 id(openai/codex app-server turn_processor.rs `start_or_steer_turn`)。
// 桥从前对第二个回来的 turn/start 又开了一次 prompt 记账,覆盖了先回来的那条 ⇒ 那一轮结束时只结算后一条,
// 另一条永远不回包,宿主一直以为在跑(停止也收不掉:取消找的是被覆盖后的记账)。
//
// 假 app-server 照 codex 的规矩做,而且要等**两条** turn/start 都到了才发 turn/started、才回包 —— 先发通知的话,
// 桥读到在跑的轮,第二条就改走 turn/steer,测不到修的那条路。回包顺序两种都钉;中途取消,两条都回 cancelled。
const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const record = (m) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
const order = process.env.FIXTURE_ORDER // 'later-first' | 'earlier-first'
const finish = process.env.FIXTURE_FINISH // 'complete' | 'wait'
const starts = []
const turn = { id: 'turn-1', status: 'inProgress' }
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  record({ method: m.method })
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'th-c' }, model: 'm' } })
  if (m.method === 'turn/start') {
    starts.push(m.id)
    if (starts.length < 2) return
    // Both arrived: one turn runs, the second joined it — codex answers both with that turn's id.
    out({ method: 'turn/started', params: { threadId: 'th-c', turn } })
    const answers = order === 'earlier-first' ? starts : [...starts].reverse()
    for (const id of answers) out({ id, result: { turn } })
    record({ answered: answers.length })
    if (finish === 'complete') setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'th-c', turn: { id: 'turn-1', status: 'completed' } } }), 50)
    return
  }
  if (m.method === 'turn/interrupt') {
    out({ id: m.id, result: {} })
    return out({ method: 'turn/completed', params: { threadId: 'th-c', turn: { id: m.params.turnId, status: 'interrupted' } } })
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

async function twoPromptsAtOnce(order: 'later-first' | 'earlier-first', finish: 'complete' | 'wait') {
  const raw = join(tmpdir(), `codex-concurrent-prompts-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'record.jsonl')
  writeFileSync(recordPath, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: recordPath, FIXTURE_ORDER: order, FIXTURE_FINISH: finish },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, unknown>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const notify = (method: string, params: unknown) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const reply = (id: number, what: string) =>
    awaitFact(what, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  const requests = () => readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method?: string; answered?: number })

  await reply(send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 'initialize')
  const { sessionId } = (await reply(send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
  const edited = send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'the edited message, resent' }] })
  const delivered = send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'a chat message that arrived at the same moment' }] })
  // Both reached codex as turn/start (not one as turn/steer) — the path the fix is about.
  await awaitFact('both turn/starts answered', () => (requests().some((r) => r.answered === 2) ? true : undefined), { producer: child })
  expect(requests().filter((r) => r.method === 'turn/start')).toHaveLength(2)
  expect(requests().some((r) => r.method === 'turn/steer')).toBe(false)
  return { sessionId, edited, delivered, reply, notify, send, requests }
}

describe('codex ACP bridge: two prompts that land in the same native turn both settle', () => {
  it.each(['later-first', 'earlier-first'] as const)('answers both when the turn completes (turn/start answers %s)', async (order) => {
    const rig = await twoPromptsAtOnce(order, 'complete')
    expect(await rig.reply(rig.edited, 'the edited prompt settles')).toMatchObject({ stopReason: 'end_turn' })
    expect(await rig.reply(rig.delivered, 'the delivered prompt settles')).toMatchObject({ stopReason: 'end_turn' })
  })

  it('cancelling the shared turn answers both as cancelled', async () => {
    const rig = await twoPromptsAtOnce('later-first', 'wait')
    // The fake wrote both answers; the bridge reads them on another stream than this cancel. One more round trip
    // through the fake first (a model change makes the bridge ask the fake for model/list): its answer comes after
    // those two on the same pipe, so once the bridge has answered it, it holds the shared turn.
    await rig.reply(rig.send('session/set_config_option', { sessionId: rig.sessionId, configId: 'model', value: 'm' }), 'one more round trip')
    expect(rig.requests().some((r) => r.method === 'model/list')).toBe(true)
    rig.notify('session/cancel', { sessionId: rig.sessionId })
    expect(await rig.reply(rig.edited, 'the edited prompt is cancelled')).toMatchObject({ stopReason: 'cancelled' })
    expect(await rig.reply(rig.delivered, 'the delivered prompt is cancelled')).toMatchObject({ stopReason: 'cancelled' })
  })
})
