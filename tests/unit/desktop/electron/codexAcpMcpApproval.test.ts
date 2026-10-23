import { observeCodexForegroundCompletion } from '../../../support/codexForegroundCompletion';
// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// 问题 9(owner 2026-09-28):Codex 对每台 MCP server 缺省按注解判,没注解就问。咕咕经 session/new 交给桥的 server
// (咕咕自己的、扩展的原生卡)都设成不逐次问;私有配置片段里只关掉一台用户 server 的那一格不碰。

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

// 假 codex app-server:记下 thread/start 的整份 config,其它请求回空结果。
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start') {
    fs.writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m.params.config ?? null))
    return out({ id: m.id, result: { thread: { id: 'th-q9' }, model: 'm' } })
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

async function threadConfig(mcpServers: unknown[], fragment: Record<string, Record<string, unknown>>) {
  const raw = join(tmpdir(), `codex-q9-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'config.json')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: recordPath, GUGU_CODEX_MCP_CONFIG: JSON.stringify(fragment) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, unknown>()
  createInterface({ input: child.stdout }).on('line', observeCodexForegroundCompletion((line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
  }))
  let nextId = 1
  const request = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
  }
  await request('initialize', { protocolVersion: 2, capabilities: {} })
  await request('session/new', { cwd: dir, mcpServers })
  return JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
}

describe('problem 9: codex does not ask before each call to a gugu-delivered MCP server', () => {
  it('approves the servers handed over, an extension native card among them, not a user server that is only switched off', async () => {
    const config = await threadConfig(
      [
        { type: 'http', name: 'gugu', url: 'http://127.0.0.1:1/mcp', headers: [] },
        { type: 'http', name: 'quiet-probe-quiet', url: 'http://127.0.0.1:1/mcp/ext', headers: [] },
      ],
      { mine: { enabled: false } },
    )
    expect(config['mcp_servers.gugu.default_tools_approval_mode']).toBe('approve')
    expect(config['mcp_servers.quiet_probe_quiet.default_tools_approval_mode']).toBe('approve')
    expect(config['mcp_servers.mine.enabled']).toBe(false)
    expect(config).not.toHaveProperty('mcp_servers.mine.default_tools_approval_mode')
  })
})

// #6900:Codex 报一次 MCP 调用是 {server, tool},审批是一条带 `_meta.tool_params`、不带条目 id 的 elicitation。桥把两处都写成
// `mcp__<server>__<tool>`(reducer 认 MCP、拆 server + 工具的标题形状),审批的入参作为 rawInput 带上。
const FAKE_CODEX_TURN = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const THREAD = 'th-6900'
const item = { type: 'mcpToolCall', id: 'item-1', server: 'l3dice', tool: 'roll', arguments: { sides: 20 }, status: 'inProgress' }
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'turn/start' || m.method === 'turn/steer') process.stdout.write(JSON.stringify({ method: 'item/started', params: { item: { type: 'userMessage', id: 'user-' + m.id, content: m.params.input } } }) + '\\n')
  if (m.id === undefined || !m.method) return
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: THREAD }, model: 'm' } })
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
    out({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 'turn-1', status: 'inProgress' } } })
    out({ method: 'item/started', params: { threadId: THREAD, turnId: 'turn-1', item } })
    return out({ id: 9001, method: 'mcpServer/elicitation/request', params: {
      threadId: THREAD, turnId: 'turn-1', serverName: 'l3dice', mode: 'form',
      message: 'Allow the l3dice MCP server to run tool "roll"?', requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'roll', tool_params: { sides: 20 } },
    } })
  }
  out({ id: m.id, result: { data: [] } })
})
`

describe('#6900: codex names an MCP call the way the reducer reads one', () => {
  it('the tool row and the tool-call approval say mcp__l3dice__roll; the approval brings its parameters as rawInput', async () => {
    const raw = join(tmpdir(), `codex-6900-${process.pid}-${Date.now()}`)
    mkdirSync(raw, { recursive: true })
    dir = realpathSync(raw)
    const fake = join(dir, 'fake-codex.cjs')
    writeFileSync(fake, FAKE_CODEX_TURN)
    chmodSync(fake, 0o755)
    const child = spawn(process.execPath, [ADAPTER], { cwd: dir, env: { ...process.env, GUGU_CODEX_BIN: fake }, stdio: ['pipe', 'pipe', 'pipe'] })
    adapter = child
    const responses = new Map<number, unknown>()
    const toolTitles: string[] = []
    let asked: { title?: string; subject?: { type: string; toolCall: unknown } } | undefined
    createInterface({ input: child.stdout }).on('line', observeCodexForegroundCompletion((line) => {
      const m = JSON.parse(line)
      if (m.method === 'session/update' && m.params?.update?.sessionUpdate === 'tool_call_update') toolTitles.push(m.params.update.title)
      if (m.method === 'session/request_permission') asked = m.params
      if (m.id !== undefined && !m.method) responses.set(m.id, m.error ?? m.result)
    }))
    let nextId = 1
    const send = (method: string, params: unknown) => {
      const id = nextId++
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return id
    }
    const reply = (id: number, what: string) => awaitFact(what, () => (responses.has(id) ? responses.get(id) : undefined), { producer: child })
    await reply(send('initialize', { protocolVersion: 2, capabilities: {} }), 'initialize')
    const created = (await reply(send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')) as { sessionId: string }
    send('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'roll' }] })
    await awaitFact('the approval reaches the client', () => asked, { producer: child })
    expect(toolTitles).toContain('mcp__l3dice__roll')
    expect(asked?.subject?.toolCall).toMatchObject({ title: 'mcp__l3dice__roll', rawInput: { sides: 20 } })
  })
})
