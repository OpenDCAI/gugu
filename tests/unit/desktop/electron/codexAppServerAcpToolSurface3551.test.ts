// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// 问题 12 —— 新线程的咕咕工具只走 MCP 那一份。
//
// 桥不再在 thread/start / fork 上声明 #3551 的动态工具(同一组工具的第二份,每轮多 8.8KB);换成线程层的两条配置:
// `mcp_servers.gugu.required` waits for startup; omit_tools_from keeps the core catalog out of deferred loading.
// Only library services and full-disclosure Apps retain the materializer's direct-only namespaces.
// 09-29 之前开的线程把动态工具存在 rollout 元数据里、resume 时 codex 原样恢复,模型仍可能调;桥不再接这条兼容链
// (owner 10-04「宁可破坏性也不要多条链路」):它们的 `item/tool/call` 得到一条 -32601,模型看得见这次失败,这一轮照常结束。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

// 假 codex app-server:记下 thread/start、thread/fork 的参数与桥发来的 mcpServer/tool/call;提示里带 LEGACY_* 时
// 像一条旧线程那样反向请求 `item/tool/call`,等桥回完再报这一轮 completed。
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const record = (m) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
const THREAD = 'th-3551'
let turnSeq = 0
const waiting = new Map()
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id !== undefined && !m.method) {
    // the bridge's answer to our reverse request
    record({ reverseAnswer: m.result ?? null, error: m.error ?? null })
    const call = waiting.get(m.id)
    if (!call) return
    // like codex: the dynamic call becomes an item (id = callId) carrying the answer, then the turn completes
    const success = m.result?.success === true
    const item = { type: 'dynamicToolCall', id: call.callId, tool: call.tool, status: success ? 'completed' : 'failed', success, contentItems: m.result?.contentItems ?? [] }
    out({ method: 'item/completed', params: { threadId: THREAD, turnId: call.turnId, item } })
    return out({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: call.turnId, status: 'completed' } } })
  }
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start' || m.method === 'thread/fork') {
    record({ method: m.method, params: m.params })
    return out({ id: m.id, result: { thread: { id: m.method === 'thread/fork' ? 'th-3551-fork' : THREAD }, model: 'm' } })
  }
  if (m.method === 'mcpServer/tool/call') {
    record({ method: m.method, params: m.params })
    const failed = m.params.tool === 'message_send'
    return out({ id: m.id, result: failed ? { isError: true, content: [{ type: 'text', text: 'chat not found' }] } : { content: [{ type: 'text', text: '[]' }] } })
  }
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq)
    const text = JSON.stringify(m.params.input ?? '')
    out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId, status: 'inProgress' } } })
    const tool = text.includes('LEGACY_REPLY') ? 'message_send' : text.includes('LEGACY_READ') ? 'message_conversations' : null
    if (!tool) return out({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: turnId, status: 'completed' } } })
    const id = 900 + turnSeq
    const callId = 'call-' + turnSeq
    waiting.set(id, { turnId, tool, callId })
    return out({ id, method: 'item/tool/call', params: { threadId: THREAD, turnId, callId, namespace: null, tool, arguments: { chat_id: 'x', text: 'hi' } } })
  }
  out({ id: m.id, result: { data: [] } })
})
`

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null

/** One line the fake wrote: a request it received (method + params) or the bridge's answer to its reverse request. */
type FakeRecord = {
  method?: string
  params?: { config?: Record<string, unknown>; server?: string; tool?: string; [key: string]: unknown }
  reverseAnswer?: { success?: boolean } | null
  error?: { code?: number } | null
}

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

// The materializer names the namespaces codex hands the model directly (codex session-bundle codexDirectNamespaces);
// a gugu-only session clears that list and uses Codex's native execution surface.
function start(env: Record<string, string> = { GUGU_CODEX_DIRECT_TOOL_NAMESPACES: '[]' }) {
  const raw = join(tmpdir(), `codex-tool-surface-3551-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'record.jsonl')
  writeFileSync(recordPath, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_DIRECT_TOOL_NAMESPACES: undefined, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: recordPath, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, { result?: unknown; error?: { code: number; message: string } }>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, { result: m.result, error: m.error })
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const reply = (id: number, what: string) => awaitFact(what, () => responses.get(id), { producer: child })
  const records = () => readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeRecord)
  return { send, reply, records }
}

const GUGU_SERVER = { name: 'gugu', url: 'http://127.0.0.1:9/mcp/session-token', headers: [] }

async function open(rig: ReturnType<typeof start>, mcpServers: unknown[]) {
  await rig.reply(rig.send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 'initialize')
  const created = (await rig.reply(rig.send('session/new', { cwd: dir, mcpServers }), 'session/new')).result as { sessionId: string }
  return created.sessionId
}

describe('问题 12 codex ACP bridge: gugu tools reach new threads through MCP only', () => {
  it('a new thread uses one required MCP catalog without forcing it outside code mode', async () => {
    const rig = start()
    await open(rig, [GUGU_SERVER])
    const started = rig.records().find((r) => r.method === 'thread/start')!
    expect(started.params).not.toHaveProperty('dynamicTools')
    expect(started.params?.config).toMatchObject({
      'mcp_servers.gugu.url': GUGU_SERVER.url,
      'mcp_servers.gugu.required': true,
      'mcp_servers.gugu.omit_tools_from': ['deferred'],
      'features.code_mode.direct_only_tool_namespaces': [],
    })
  })

  it('a fork carries the same thread config (codex does not persist config overrides)', async () => {
    const rig = start()
    const providerSessionId = await open(rig, [GUGU_SERVER])
    await rig.reply(rig.send('session/fork', { sessionId: providerSessionId, cwd: dir, mcpServers: [GUGU_SERVER] }), 'session/fork')
    const forked = rig.records().find((r) => r.method === 'thread/fork')!
    expect(forked.params).not.toHaveProperty('dynamicTools')
    expect(forked.params?.config).toMatchObject({
      'mcp_servers.gugu.required': true,
      'mcp_servers.gugu.omit_tools_from': ['deferred'],
      'features.code_mode.direct_only_tool_namespaces': [],
    })
  })

  it('without a gugu server nothing is marked required (an extension or integration server stays optional)', async () => {
    const rig = start()
    await open(rig, [{ name: 'ext-probe', url: 'http://127.0.0.1:9/mcp/ext', headers: [] }])
    const config = rig.records().find((r) => r.method === 'thread/start')!.params?.config ?? {}
    expect(Object.keys(config).filter((k) => k.endsWith('.required'))).toEqual([])
  })

  it('the namespaces outside code mode are exactly the ones the materializer names (10-06)', async () => {
    const rig = start({ GUGU_CODEX_DIRECT_TOOL_NAMESPACES: '["mcp__gw_probe_a"]' })
    await open(rig, [GUGU_SERVER, { name: 'gw-probe-a', url: 'http://127.0.0.1:9/mcp/ext', headers: [] }])
    const config = rig.records().find((r) => r.method === 'thread/start')!.params?.config ?? {}
    expect(config['features.code_mode.direct_only_tool_namespaces']).toEqual(['mcp__gw_probe_a'])
    expect(config).not.toHaveProperty(['mcp_servers.gw_probe_a.omit_tools_from'])
  })

  it('nothing named, nothing set: a server the person configured stays as codex has it', async () => {
    const rig = start({})
    await open(rig, [{ name: 'my-own', url: 'http://127.0.0.1:9/mcp/own', headers: [] }])
    const config = rig.records().find((r) => r.method === 'thread/start')!.params?.config ?? {}
    expect(config).not.toHaveProperty(['features.code_mode.direct_only_tool_namespaces'])
  })

  it('an older thread that still calls a restored dynamic tool gets a loud refusal, and its turn still ends', async () => {
    const rig = start()
    const providerSessionId = await open(rig, [GUGU_SERVER])
    const outcome = await rig.reply(rig.send('session/prompt', { sessionId: providerSessionId, prompt: [{ type: 'text', text: 'LEGACY_REPLY' }] }), 'legacy call settles')
    expect(outcome).toEqual({ result: { stopReason: 'end_turn' }, error: undefined })
    // 桥不再替旧线程执行:假 codex 一条 mcpServer/tool/call 都没收到。
    expect(rig.records().filter((r) => r.method === 'mcpServer/tool/call')).toEqual([])
    expect(rig.records().find((r) => 'reverseAnswer' in r)).toMatchObject({ reverseAnswer: null, error: { code: -32601 } })
  })
})
