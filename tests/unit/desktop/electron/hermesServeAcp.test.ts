// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// The Hermes bridge end to end over its two real protocols: ACP on stdio to the test (standing in for Gugu's
// runtime), the serve gateway's JSON-RPC over a real WebSocket to a fake `hermes serve` that plays scripted turns.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/hermes-serve-acp.ts')
const WS_MODULE = createRequire(__filename).resolve('ws')

const FAKE_HERMES = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require(process.env.FAKE_WS_MODULE)
const record = (entry) => fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(entry) + '\n')
if (process.argv[2] !== 'serve') process.exit(3)
record({
  kind: 'spawn',
  argv: process.argv.slice(2),
  managed: JSON.parse(fs.readFileSync(path.join(process.env.HERMES_MANAGED_DIR, 'config.yaml'), 'utf8')),
  env: {
    platformKey: process.env.GUGU_HERMES_PLATFORM_KEY ?? null,
    secret0: process.env.GUGU_HERMES_SECRET_0 ?? null,
    bridgeInputsLeaked: ['GUGU_HERMES_BIN', 'GUGU_PLATFORM_MODELS', 'GUGU_HERMES_PLATFORM_MODEL'].filter((k) => k in process.env),
  },
})
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
wss.on('listening', () => process.stdout.write('HERMES_BACKEND_READY port=' + wss.address().port + '\n'))
wss.on('connection', (ws, req) => {
  if (!req.url.includes(encodeURIComponent(process.env.HERMES_DASHBOARD_SESSION_TOKEN))) return ws.close(4001)
  const send = (m) => ws.send(JSON.stringify(m))
  const event = (type, payload) => send({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'rt-1', payload } })
  const waiting = new Map()
  let serverId = 1
  const ask = (method, params) => new Promise((done) => { const id = 's' + serverId++; waiting.set(id, done); send({ jsonrpc: '2.0', id, method, params }) })
  const info = { desktop_contract: Number(process.env.FAKE_CONTRACT ?? 8), model: process.env.FAKE_MODEL ?? 'glm-5.3', provider: process.env.FAKE_PROVIDER ?? 'custom:gugu-platform', reasoning_effort: '', yolo: false }
  const history = []
  let running = false
  let interrupted = false
  // Hermes builds the session's agent in the background after create / resume and announces it with session.info;
  // a reasoning pick before that is acknowledged and lost (the worst case of the real race).
  let built = false
  const announceBuild = () => setTimeout(() => { built = true; record({ kind: 'built' }); event('session.info', { ...info }) }, 100)
  const steers = []
  const until = async (check) => { while (!check()) await new Promise((r) => setTimeout(r, 10)) }
  async function turn(text) {
    running = true
    interrupted = false
    history.push({ role: 'user', text })
    record({ kind: 'turn', reasoning: info.reasoning_effort })
    event('message.start', {})
    if (text.includes('APPROVE')) {
      event('tool.start', { tool_id: 'tool-1', name: 'terminal', args: { command: 'rm -rf x' } })
      record({ kind: 'approval-answer', answer: await ask('approval', { session_id: 'rt-1', request_id: 'req-1', command: 'rm -rf x', description: 'recursive delete', allow_session: true, allow_permanent: false, choices: ['once', 'session', 'deny'] }) })
      event('tool.complete', { tool_id: 'tool-1', name: 'terminal', result_text: 'done' })
    }
    if (text.includes('CLARIFY-BATCH')) {
      record({ kind: 'clarify-answer', answer: await ask('clarify', { session_id: 'rt-1', questions: [{ qid: 'q1', question: 'Pick one', choices: ['a', 'b'] }, { qid: 'q2', question: 'Say anything' }] }) })
    }
    if (text.includes('CLARIFY-SINGLE')) {
      record({ kind: 'clarify-answer', answer: await ask('clarify', { session_id: 'rt-1', question: 'Pick one', choices: ['x', 'y'] }) })
    }
    if (text.includes('SLOW')) await until(() => steers.length > 0)
    if (text.includes('WAIT-CANCEL')) await until(() => interrupted)
    for (const steer of steers.splice(0)) history.push({ role: 'user', text: steer, display_kind: 'steer' })
    event('reasoning.delta', { text: 'thinking' })
    event('message.delta', { text: 'answer:' + text.slice(0, 20) })
    history.push({ role: 'assistant', text: 'answer' })
    running = false
    event('message.complete', { text: 'answer', status: interrupted ? 'interrupted' : 'complete', usage: { context_used: 100, context_max: 1000 } })
  }
  event('gateway.ready', { skin: {}, change_events: true, replay_epoch: 'x' })
  ws.on('message', async (raw) => {
    const m = JSON.parse(String(raw))
    if (m.method === undefined) { waiting.get(m.id)?.(m.result); return }
    record({ kind: 'rpc', method: m.method, params: m.params })
    const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
    const p = m.params ?? {}
    switch (m.method) {
      case 'client.capabilities':
        return reply({ server_requests: ['approval', 'clarify'] })
      case 'session.create': reply({ session_id: 'rt-1', stored_session_id: 'stored-1', message_count: 0, messages: [], info }); return announceBuild()
      case 'session.resume': reply({ session_id: 'rt-1', stored_session_id: p.session_id, message_count: 3, info, messages: [
        { role: 'user', text: 'old question', row_id: 1 },
        { role: 'assistant', text: 'old answer', reasoning: 'old thought', row_id: 2 },
        { role: 'tool', name: 'terminal', args: { command: 'ls' }, tool_call_id: 'tc-9' },
      ] }); return announceBuild()
      case 'model.options': return reply({ providers: [{ slug: 'openrouter', name: 'OpenRouter', models: ['anthropic/claude-opus-4.6'], capabilities: { 'anthropic/claude-opus-4.6': { fast: false, reasoning: true, can_disable_reasoning: false } } }] })
      case 'commands.catalog': return reply({ pairs: [['/compress', 'Compress context'], ['/model', 'Switch model'], ['/goal', 'Goal']], commands: { compress: { desktop: null }, goal: { desktop: 'goal-panel' } }, skills: { 'my-skill': { description: 'Mine' } } })
      case 'config.set':
        if (p.key === 'reasoning' && built) info.reasoning_effort = p.value
        if (p.key === 'yolo') info.yolo = p.value === 'on'
        return reply({ key: p.key, value: p.value, scope: 'session' })
      case 'prompt.submit':
        reply({ status: running ? 'queued' : 'streaming' })
        return turn(p.text)
      case 'session.steer':
        if (!running) return reply({ status: 'rejected', text: p.text })
        steers.push(p.text)
        return reply({ status: 'queued', text: p.text })
      case 'session.history': return reply({ count: history.length, messages: history })
      case 'session.interrupt': interrupted = true; return reply({ status: 'interrupted' })
      case 'session.close': return reply({ closed: true })
      case 'reload.mcp': return reply({ status: 'reloaded' })
      case 'image.attach_bytes': return reply({ attached: true })
      default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'fake: ' + m.method } })
    }
  })
})
`

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

let dir = ''
let adapter: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  const child = adapter
  adapter = null
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done))
    child.stdin.end()
    await exited
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const PLATFORM_ENV = {
  GUGU_HERMES_PLATFORM_BASE_URL: 'https://relay.test.invalid/v1',
  GUGU_HERMES_PLATFORM_KEY: 'platform-key-123',
  GUGU_HERMES_PLATFORM_MODEL: 'glm-5.3',
  GUGU_PLATFORM_MODELS: JSON.stringify([
    { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 200000, efforts: ['low', 'high', 'max'] },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', contextWindow: 400000, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ]),
}

/** Answers `session/request_permission` with the option a test chose. */
function startBridge(env: Record<string, string>, permissionAnswer: (params: Record<string, unknown>) => string = () => 'deny') {
  const raw = join(tmpdir(), `hermes-serve-acp-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'hermes')
  writeFileSync(fake, FAKE_HERMES)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'record.jsonl')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_HERMES_BIN: fake, FAKE_RECORD: recordPath, FAKE_WS_MODULE: WS_MODULE, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, Message>()
  const updates: Record<string, unknown>[] = []
  const permissionRequests: Record<string, unknown>[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line) as Message
    if (m.method === 'session/update') updates.push((m.params?.update ?? {}) as Record<string, unknown>)
    else if (m.method === 'session/request_permission' && m.id !== undefined) {
      permissionRequests.push(m.params ?? {})
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: permissionAnswer(m.params ?? {}) } } }) + '\n')
    } else if (m.id !== undefined && !m.method) responses.set(m.id, m)
  })
  let nextId = 1
  const send = (method: string, params: unknown) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  const response = (id: number) => awaitFact(`ACP response ${id}`, () => responses.get(id), { producer: child })
  const request = async (method: string, params: unknown) => response(send(method, params))
  const records = () => (existsSync(recordPath) ? readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const rpcs = (method: string) => records().filter((r) => r.kind === 'rpc' && r.method === method).map((r) => r.params)
  return { child, send, response, request, records, rpcs, updates, permissionRequests, notify: (method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
}

const option = (result: unknown, category: string) =>
  ((result as { configOptions?: Record<string, unknown>[] }).configOptions ?? []).find((o) => o.category === category)

async function newSession(bridge: ReturnType<typeof startBridge>) {
  await bridge.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  return bridge.request('session/new', {
    cwd: dir,
    mcpServers: [{ name: 'gugu', url: 'http://127.0.0.1:44100/mcp', headers: [{ name: 'Authorization', value: 'Bearer mcp-secret' }] }],
    _meta: { systemPrompt: { append: 'GUGU-PLATFORM-BLOCK' } },
  })
}

describe('hermes serve bridge', () => {
  it('a platform session: the managed overlay carries Gugu provider + MCP with secrets only in env; the system block is a hidden seed row', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    const created = await newSession(bridge)
    expect(created.error).toBeUndefined()
    expect((created.result as { sessionId: string }).sessionId).toBe('stored-1')
    const spawned = bridge.records().find((r) => r.kind === 'spawn')
    expect(spawned.argv).toEqual(['serve', '--isolated', '--host', '127.0.0.1', '--port', '0'])
    expect(spawned.managed.providers['gugu-platform']).toMatchObject({ base_url: 'https://relay.test.invalid/v1', api_key: '${GUGU_HERMES_PLATFORM_KEY}', transport: 'codex_responses' })
    expect(spawned.managed.mcp_servers.gugu).toEqual({ url: 'http://127.0.0.1:44100/mcp', headers: { Authorization: '${GUGU_HERMES_SECRET_0}' } })
    expect(spawned.env).toEqual({ platformKey: 'platform-key-123', secret0: 'Bearer mcp-secret', bridgeInputsLeaked: [] })
    expect(JSON.stringify(spawned.managed)).not.toContain('platform-key-123')
    expect(bridge.rpcs('session.create')[0]).toEqual({
      cwd: dir,
      source: 'acp',
      messages: [{ role: 'user', content: 'GUGU-PLATFORM-BLOCK', display_kind: 'hidden' }],
      model: 'glm-5.3',
      provider: 'custom:gugu-platform',
    })
    expect(option(created.result, 'model')).toMatchObject({ currentValue: 'gugu-platform/glm-5.3' })
    expect((option(created.result, 'thought_level')?.options as { value: string }[]).map((o) => o.value)).toEqual(['low', 'high', 'max'])
    // Gugu's MCP is declared only by the managed overlay, which Hermes' own discovery skips: reloaded before any session.
    const order = bridge.records().filter((r) => r.kind === 'rpc' && (r.method === 'reload.mcp' || r.method === 'session.create')).map((r) => r.method)
    expect(order).toEqual(['reload.mcp', 'session.create'])
    expect(bridge.rpcs('reload.mcp')).toEqual([{ confirm: true }])
    await awaitFact('commands', () => bridge.updates.find((u) => u.sessionUpdate === 'available_commands_update'))
    const commands = bridge.updates.find((u) => u.sessionUpdate === 'available_commands_update')!.availableCommands as { name: string }[]
    expect(commands.map((c) => c.name)).toEqual(['compress', 'my-skill'])
  })

  it('effort, model and approvals are session-scoped config.set calls, the way Hermes Desktop sets them', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await newSession(bridge)
    const effort = await bridge.request('session/set_config_option', { sessionId: 'stored-1', configId: 'effort', value: 'high' })
    expect(option(effort.result, 'thought_level')).toMatchObject({ currentValue: 'high' })
    const model = await bridge.request('session/set_config_option', { sessionId: 'stored-1', configId: 'model', value: 'gugu-platform/gpt-5.6-sol' })
    expect((option(model.result, 'thought_level')?.options as { value: string }[]).map((o) => o.value)).toContain('xhigh')
    await bridge.request('session/set_config_option', { sessionId: 'stored-1', configId: 'mode', value: 'yolo' })
    expect(bridge.rpcs('config.set')).toEqual([
      { key: 'reasoning', value: 'high', session_id: 'rt-1' },
      { key: 'model', value: 'gpt-5.6-sol --provider gugu-platform --session', session_id: 'rt-1' },
      { key: 'yolo', value: 'on', session_id: 'rt-1' },
    ])
    const refused = await bridge.request('session/set_config_option', { sessionId: 'stored-1', configId: 'effort', value: 'banana' })
    expect(refused.error?.code).toBe(-32602)
  })

  it('a level picked right after session/new reaches the first turn: the setting waits for the built agent', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await newSession(bridge)
    await bridge.request('session/set_config_option', { sessionId: 'stored-1', configId: 'effort', value: 'high' })
    await bridge.request('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'go' }] })
    expect(bridge.records().filter((r) => r.kind === 'turn').map((r) => r.reasoning)).toEqual(['high'])
  })

  it('a prompt streams and ends with its turn; the session title reads the message body, not the delivery envelope', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await newSession(bridge)
    const done = await bridge.request('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: '<gugu_delivery from="x"><![CDATA[hello there]]></gugu_delivery>' }] })
    expect(done.result).toEqual({ stopReason: 'end_turn' })
    expect(bridge.rpcs('prompt.submit')[0]).toMatchObject({ queued: true, title_preview: 'hello there' })
    expect(bridge.updates.map((u) => u.sessionUpdate)).toEqual(expect.arrayContaining(['agent_thought_chunk', 'agent_message_chunk', 'usage_update']))
  })

  it('steering joins the running turn (one answer for the prompt); idle steering asks for a prompt', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await newSession(bridge)
    const promptId = bridge.send('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'SLOW task' }] })
    await awaitFact('submitted', () => (bridge.rpcs('prompt.submit').length === 1 ? true : undefined))
    // Whether this lands before or after the turn's `message.start` reaches the bridge, it joins that turn:
    // before it, the bridge holds the steer until the turn starts (Hermes has no agent yet).
    const steer = await bridge.request('_session/steering', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'STEER-MARK also this' }] })
    expect(steer.result).toEqual({ outcome: 'injected' })
    expect((await bridge.response(promptId)).result).toEqual({ stopReason: 'end_turn' })
    const idle = await bridge.request('_session/steering', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'late' }] })
    expect(idle.result).toEqual({ outcome: 'promptRequired' })
  })

  it('an approval asks the person through ACP and returns their pick to Hermes', async () => {
    const bridge = startBridge(PLATFORM_ENV, () => 'session')
    await newSession(bridge)
    await bridge.request('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'APPROVE please' }] })
    expect(bridge.permissionRequests[0]).toMatchObject({
      sessionId: 'stored-1',
      toolCall: { toolCallId: 'tool-1', kind: 'execute', title: 'recursive delete' },
    })
    expect((bridge.permissionRequests[0]!.options as { optionId: string }[]).map((o) => o.optionId)).toEqual(['once', 'session', 'deny'])
    expect(bridge.records().find((r) => r.kind === 'approval-answer').answer).toEqual({ choice: 'session' })
  })

  it('clarify: the batch form is asked and answered {answers}; the single form v2026.9.24 sends is not asked', async () => {
    const bridge = startBridge(PLATFORM_ENV, (params) => ((params.options as { name: string; optionId: string }[]).find((o) => o.name === 'b' || o.name === 'y')!.optionId))
    await newSession(bridge)
    await bridge.request('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'CLARIFY-BATCH' }] })
    await bridge.request('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'CLARIFY-SINGLE' }] })
    expect(bridge.records().filter((r) => r.kind === 'clarify-answer').map((r) => r.answer)).toEqual([
      { answers: { q1: 'b', q2: null } },
      { answers: {} },
    ])
    // A choice carries its own text; none refuses, so the runtime reads the request as a question (pi's select shape).
    expect(bridge.permissionRequests.map((p) => (p.options as { name: string; kind: string }[]).map((o) => `${o.name}:${o.kind}`)))
      .toEqual([['a:allow_once', 'b:allow_once']])
  })

  it('load resumes the stored session and replays its history before answering', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await bridge.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const loaded = await bridge.request('session/load', { sessionId: 'stored-7', cwd: dir, mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(bridge.rpcs('session.resume')[0]).toEqual({ session_id: 'stored-7', source: 'acp' })
    expect(bridge.updates.slice(0, 4).map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'tool_call'])
  })

  it('load without replay restores configuration and still streams the next live turn', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await bridge.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const loaded = await bridge.request('session/load', {
      sessionId: 'stored-7', cwd: dir, mcpServers: [], _meta: { history: { replay: false } },
    })
    expect(loaded.error).toBeUndefined()
    expect(option(loaded.result, 'model')).toBeDefined()
    expect(bridge.updates.filter((u) => /message_chunk|thought_chunk|tool_call/.test(String(u.sessionUpdate)))).toEqual([])
    const response = await bridge.request('session/prompt', { sessionId: 'stored-7', prompt: [{ type: 'text', text: 'next live input' }] })
    expect(response.result).toEqual({ stopReason: 'end_turn' })
    expect(bridge.updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true)
  })

  it('cancel interrupts the turn and its prompt ends cancelled', async () => {
    const bridge = startBridge(PLATFORM_ENV)
    await newSession(bridge)
    const promptId = bridge.send('session/prompt', { sessionId: 'stored-1', prompt: [{ type: 'text', text: 'WAIT-CANCEL' }] })
    await awaitFact('submitted', () => (bridge.rpcs('prompt.submit').length === 1 ? true : undefined))
    bridge.notify('session/cancel', { sessionId: 'stored-1' })
    expect((await bridge.response(promptId)).result).toEqual({ stopReason: 'cancelled' })
    expect(bridge.rpcs('session.interrupt')).toEqual([{ session_id: 'rt-1' }])
  })

  it("an own-account session lists the user's authenticated Hermes models with Hermes' reasoning ladder", async () => {
    const bridge = startBridge({ FAKE_MODEL: 'anthropic/claude-opus-4.6', FAKE_PROVIDER: 'openrouter' })
    const created = await newSession(bridge)
    expect(bridge.records().find((r) => r.kind === 'spawn').managed.providers).toBeUndefined()
    expect(bridge.rpcs('session.create')[0]).not.toHaveProperty('model')
    expect(option(created.result, 'model')).toMatchObject({ currentValue: 'openrouter/anthropic/claude-opus-4.6' })
    // can_disable_reasoning: false ⇒ no `none`
    expect((option(created.result, 'thought_level')?.options as { value: string }[]).map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('a serve that speaks another contract is refused, naming the number', async () => {
    const bridge = startBridge({ ...PLATFORM_ENV, FAKE_CONTRACT: '9' })
    const created = await newSession(bridge)
    expect(created.error?.message).toMatch(/contract 9.*supports contract 8/)
  })
})
