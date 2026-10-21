// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// #6353 —— 停止这一轮 = 这一轮起的命令也停。
//
// mac1 实测(codex 0.147,真产品):宿主点停 → 桥发 `turn/interrupt` → codex 16ms 回
// `turn/completed(interrupted)`,但这一轮的 `sleep 600` 仍挂在 codex 下跑 —— codex 的 interrupt
// **故意**把在跑的命令转成 thread 的后台终端留着。杀它的唯一入口是 `thread/backgroundTerminals/terminate`。
// 这条用例用一个假的 app-server 站在 codex 的位置,钉住桥这一层的合同:
//   ① 取消时先 interrupt、再按 processId terminate 这一轮的命令;
//   ② 更早那一轮**正常结束**时留在后台的命令(模型有意放出去的)不碰;
//   ③ 阴控:这一轮没有在跑的命令时,取消不发 terminate。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

// 假 codex app-server:只回答这条流程需要的方法,其它请求一律回一个空结果;所有请求记进 FIXTURE_RECORD。
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const record = (m) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
let turnSeq = 0
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  record({ method: m.method, params: m.params && { turnId: m.params.turnId, processId: m.params.processId } })
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'th-6353' }, model: 'm' } })
  if (m.method === 'turn/start') {
    const n = ++turnSeq
    const turnId = 'turn-' + n
    const text = JSON.stringify(m.params.input ?? '')
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: 'th-6353', turn: { id: turnId, status: 'inProgress' } } })
    const processId = text.includes('KEEP') ? 'proc-keep' : 'proc-' + n
    out({ method: 'item/started', params: { threadId: 'th-6353', turnId, item: { type: 'commandExecution', id: 'item-' + n, status: 'inProgress', command: 'sleep 600', processId } } })
    if (text.includes('KEEP')) out({ method: 'turn/completed', params: { threadId: 'th-6353', turn: { id: turnId, status: 'completed' } } })
    if (text.includes('IDLE')) {
      out({ method: 'item/completed', params: { threadId: 'th-6353', turnId, item: { type: 'commandExecution', id: 'item-' + n, status: 'completed', processId } } })
    }
    return
  }
  if (m.method === 'turn/interrupt') {
    out({ id: m.id, result: {} })
    return out({ method: 'turn/completed', params: { threadId: 'th-6353', turn: { id: m.params.turnId, status: 'interrupted' } } })
  }
  if (m.method === 'thread/backgroundTerminals/terminate') return out({ id: m.id, result: { terminated: true } })
  out({ id: m.id, result: { data: [] } })
})
`

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  // SIGTERM 走桥自己的 shutdown(它会停掉假 codex);SIGKILL 会把假 codex 留成孤儿。
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
  const raw = join(tmpdir(), `codex-cancel-6353-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'record.jsonl')
  writeFileSync(recordPath, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: recordPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, unknown>()
  const toolCalls = new Set<string>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'tool_call') toolCalls.add(String(m.params.update.toolCallId))
  })
  // 桥发出 tool_call = 它已经处理了那条 item/started(记账在同一处)—— 取消要等到这之后才有意义。
  const commandSeen = (itemId: string) =>
    awaitFact(`bridge saw ${itemId}`, () => (toolCalls.has(itemId) ? true : undefined), { producer: child })
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
  const requests = () =>
    readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; params?: { turnId?: string; processId?: string } })
  return { send, notify, reply, requests, commandSeen }
}

async function openSession(rig: ReturnType<typeof start>) {
  await rig.reply(rig.send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 'initialize')
  const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
  expect(created.sessionId).toBe('th-6353')
  return created.sessionId
}

const prompt = (text: string) => [{ type: 'text', text }]

describe('#6353 codex ACP bridge: cancelling a turn stops that turn’s commands', () => {
  it('interrupts, then terminates only the cancelled turn’s running command (earlier turn’s background command kept)', async () => {
    const rig = start()
    const providerSessionId = await openSession(rig)
    // turn-1 正常结束,留下一个后台命令 proc-keep(模型有意放出去的)。
    await rig.reply(rig.send('session/prompt', { sessionId: providerSessionId, prompt: prompt('KEEP') }), 'turn-1 settles')
    // turn-2 起了 proc-2,还在跑时人点了停。
    const running = rig.send('session/prompt', { sessionId: providerSessionId, prompt: prompt('RUN') })
    await rig.commandSeen('item-2')
    rig.notify('session/cancel', { sessionId: providerSessionId })
    expect(await rig.reply(running, 'turn-2 settles')).toEqual({ stopReason: 'cancelled' })
    await awaitFact('terminate sent', () => (rig.requests().some((r) => r.method === 'thread/backgroundTerminals/terminate') ? true : undefined))

    const tail = rig.requests().filter((r) => r.method === 'turn/interrupt' || r.method === 'thread/backgroundTerminals/terminate')
    expect(tail.map((r) => [r.method, r.params?.turnId ?? r.params?.processId])).toEqual([
      ['turn/interrupt', 'turn-2'],
      ['thread/backgroundTerminals/terminate', 'proc-2'],
    ])
  })

  it('negative control: a cancelled turn whose command already finished sends no terminate', async () => {
    const rig = start()
    const providerSessionId = await openSession(rig)
    const running = rig.send('session/prompt', { sessionId: providerSessionId, prompt: prompt('IDLE') })
    await rig.commandSeen('item-1')
    rig.notify('session/cancel', { sessionId: providerSessionId })
    expect(await rig.reply(running, 'turn settles')).toEqual({ stopReason: 'cancelled' })
    // interrupt 已到 ⇒ 若要发 terminate,它会紧跟着 interrupt 发出;再等桥处理完一条后来的请求,确认没有。
    await rig.reply(rig.send('session/set_mode', { sessionId: providerSessionId, modeId: 'nope' }), 'one more round trip')
    expect(rig.requests().some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(rig.requests().some((r) => r.method === 'thread/backgroundTerminals/terminate')).toBe(false)
  })
})
