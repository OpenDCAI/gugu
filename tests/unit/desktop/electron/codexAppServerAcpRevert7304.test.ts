import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { awaitFact } from '../../../support/awaitFact'

const ADAPTER = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let n = 0
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line)
  fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
  if (!m.id) return
  if (m.method === 'initialize') return out({id:m.id,result:{userAgent:'fixture'}})
  if (m.method === 'thread/start') return out({id:m.id,result:{thread:{id:'same-thread',historyMode:process.env.FIXTURE_HISTORY_MODE,ephemeral:false},model:'gpt-5',reasoningEffort:'medium'}})
  if (m.method === 'thread/read') return out({id:m.id,result:{thread:{id:'same-thread',turns:[]}}})
  if (m.method === 'thread/revert') {
    if (m.params.beforeTurnId === 'legacy') return out({id:m.id,error:{code:-32602,message:'thread does not support paginated history'}})
    return out({id:m.id,result:{thread:{id:m.params.beforeTurnId === 'wrong-id' ? 'other-thread' : 'same-thread'}}})
  }
  if (m.method === 'turn/start') {
    const turn = {id:'turn-' + ++n,status:'completed'}
    out({id:m.id,result:{turn}})
    return out({method:'turn/completed',params:{threadId:'same-thread',turn}})
  }
  if (m.method === 'model/list') return out({id:m.id,result:{data:[{id:'gpt-5',model:'gpt-5',displayName:'GPT-5',isDefault:true,supportedReasoningEfforts:[]}]}})
  out({id:m.id,result:{data:[]}})
})
`

let dir = ''
let child: ChildProcessWithoutNullStreams | undefined
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise((done) => child!.once('exit', done))
    child.kill('SIGTERM')
    await ended
  }
  child = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function open(historyMode = 'paginated') {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-revert-7304-')))
  const fake = join(dir, 'fake-codex.cjs')
  const record = join(dir, 'requests.jsonl')
  writeFileSync(fake, FAKE_CODEX)
  writeFileSync(record, '')
  chmodSync(fake, 0o755)
  const process = spawn(globalThis.process.execPath, [ADAPTER], {
    cwd: dir, env: { ...globalThis.process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: record, FIXTURE_HISTORY_MODE: historyMode, GUGU_HOME: join(dir, 'gugu-home'), GUGU_USER_DATA_DIR: join(dir, 'gugu-userdata') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child = process
  const replies = new Map<number, { result?: unknown; error?: unknown }>()
  createInterface({ input: process.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && !message.method) replies.set(message.id, message)
  })
  let id = 0
  const request = async (method: string, params: unknown) => {
    const requestId = ++id
    process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    return awaitFact(method, () => replies.get(requestId), { producer: process })
  }
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  expect(await request('session/new', { cwd: dir, mcpServers: [] })).toMatchObject({ result: { sessionId: 'same-thread' } })
  return { request, requests: () => readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) }
}

describe('conversation revert keeps the native Codex thread (#7304)', () => {
  it('does not offer receipts or call revert for legacy history', async () => {
    const rig = await open('legacy');
    expect(await rig.request('session/prompt', { sessionId: 'same-thread', prompt: [{ type: 'text', text: 'hello' }] }))
      .toMatchObject({ result: { stopReason: 'end_turn' } });
    const result = await rig.request('session/prompt', { sessionId: 'same-thread', prompt: [{ type: 'text', text: 'again' }] });
    expect(result.result).not.toHaveProperty('_meta');
    expect(await rig.request('_session/revert', { sessionId: 'same-thread', before: 'turn-1' }))
      .toMatchObject({ error: { message: expect.stringContaining('paginated') } });
    expect(rig.requests().some((r) => r.method === 'thread/revert')).toBe(false);
  });
  it('returns a native receipt and uses thread/revert on the original thread', async () => {
    const rig = await open()
    expect(await rig.request('session/prompt', { sessionId: 'same-thread', prompt: [{ type: 'text', text: 'hello' }] }))
      .toMatchObject({ result: { stopReason: 'end_turn', _meta: { guguRevert: { before: 'turn-1' } } } })
    expect(await rig.request('_session/revert', { sessionId: 'same-thread', before: 'turn-1' }))
      .toMatchObject({ result: { sessionId: 'same-thread' } })
    const requests = rig.requests()
    expect(requests.find((r) => r.method === 'thread/start')?.params.historyMode).toBe('paginated')
    expect(requests.filter((r) => r.method === 'thread/revert').map((r) => r.params))
      .toEqual([{ threadId: 'same-thread', beforeTurnId: 'turn-1' }])
    expect(requests.some((r) => r.method === 'thread/fork')).toBe(false)
  })
  it('reports legacy-history refusal without falling back to a fork', async () => {
    const rig = await open()
    expect(await rig.request('_session/revert', { sessionId: 'same-thread', before: 'legacy' }))
      .toMatchObject({ error: { message: expect.stringContaining('paginated') } })
    expect(rig.requests().some((r) => r.method === 'thread/fork')).toBe(false)
  })
  it('refuses mismatched identities and a provider that returns a different thread', async () => {
    const rig = await open()
    expect(await rig.request('_session/revert', { sessionId: 'foreign-thread', before: 'turn-1' }))
      .toMatchObject({ error: { message: expect.stringContaining('Invalid') } })
    expect(rig.requests().some((r) => r.method === 'thread/revert')).toBe(false)
    expect(await rig.request('_session/revert', { sessionId: 'same-thread', before: 'wrong-id' }))
      .toMatchObject({ error: { message: expect.stringContaining('thread ID') } })
  })
})
