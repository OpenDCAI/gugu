// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// `/compact` 在 Codex 的聊天面板腿上。
//
// mac1 实测(真产品,codex 0.156.1 + GLM-5.3):这条腿从前没有实现它,`/compact` 被当成一句普通的话
// 走 `turn/start`,模型回「Conversation compacted: …」,网关那一行是一次普通的 23k 请求、窗口前后不变。
// codex 的压缩入口是 `thread/compact/start`:回 `{}` 不带轮次 id,压缩以一轮的形式跑(`turn/started` …
// `turn/completed`)。假 app-server 站在 codex 的位置,钉住桥这一层的合同:
//   ① `/compact` 发 `thread/compact/start`、不发 `turn/start`,这条请求等到压缩那一轮结束才回;
//   ② `turn/started` 先于 `thread/compact/start` 的回包到达也认得出(两者在同一条管道上,先后不保证);
//   ③ 命令清单里报出 `compact`;压缩条目映射成 `compaction_update`(宿主的分隔线);
//   ④ 阴控:普通的话照旧走 `turn/start`。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

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
  record({ method: m.method })
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'th-compact' }, model: 'm' } })
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + ++turnSeq
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    return out({ method: 'turn/completed', params: { threadId: 'th-compact', turn: { id: turnId, status: 'completed' } } })
  }
  if (m.method === 'thread/compact/start') {
    const turnId = 'turn-' + ++turnSeq
    out({ method: 'turn/started', params: { threadId: 'th-compact', turn: { id: turnId, status: 'inProgress' } } })
    out({ id: m.id, result: {} })
    out({ method: 'item/started', params: { threadId: 'th-compact', turnId, item: { type: 'contextCompaction', id: 'cmp-1' } } })
    out({ method: 'item/completed', params: { threadId: 'th-compact', turnId, item: { type: 'contextCompaction', id: 'cmp-1' } } })
    return out({ method: 'turn/completed', params: { threadId: 'th-compact', turn: { id: turnId, status: 'completed' } } })
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
  const raw = join(tmpdir(), `codex-compact-${process.pid}-${Date.now()}`)
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
  const compactions: string[] = []
  let commands: string[] | null = null
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    const update = m.method === 'session/update' ? m.params?.update : null
    if (update?.sessionUpdate === 'available_commands_update') {
      commands = (update.availableCommands as { name: string }[]).map((c) => c.name)
    }
    if (update?.sessionUpdate === 'compaction_update') compactions.push(`${update.compactionId}:${update.status}`)
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const reply = (id: number, what: string) =>
    awaitFact(what, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  const methods = () =>
    readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { method: string }).method)
  const advertised = () => awaitFact('commands published', () => commands ?? undefined, { producer: child })
  return { send, reply, methods, advertised, compactions }
}

const prompt = (text: string) => [{ type: 'text', text }]

describe('codex ACP bridge: /compact is codex’s own compaction', () => {
  it('starts thread/compact/start, waits for that turn, and advertises the command', async () => {
    const rig = start()
    await rig.reply(rig.send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 'initialize')
    const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
    expect(await rig.advertised()).toContain('compact')

    expect(await rig.reply(rig.send('session/prompt', { sessionId: created.sessionId, prompt: prompt('/compact') }), '/compact settles'))
      .toEqual({ stopReason: 'end_turn' })
    expect(rig.methods()).toContain('thread/compact/start')
    expect(rig.methods()).not.toContain('turn/start')
    // 宿主画「上下文已压缩」分隔线的那条更新(自动压缩走同一个条目)。
    expect(rig.compactions).toEqual(['cmp-1:in_progress', 'cmp-1:completed'])

    expect(await rig.reply(rig.send('session/prompt', { sessionId: created.sessionId, prompt: prompt('hello') }), 'plain prompt settles'))
      .toEqual({ stopReason: 'end_turn' })
    expect(rig.methods().filter((m) => m === 'turn/start')).toHaveLength(1)
  })
})
