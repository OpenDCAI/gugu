// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'

// #6387 installed Apps' skills on Codex's chat leg: the materializer hands the bridge one skill root
// (GUGU_CODEX_SKILL_ROOTS), and the bridge registers it with app-server `skills/extraRoots/set` before any thread —
// codex then lists those skills as its own. A fake app-server stands where codex stands and records what it is asked:
//   ① with the env: `skills/extraRoots/set` carries the roots and comes before `thread/start`;
//   ② negative control: without it, the bridge asks nothing of the kind;
//   ③ a codex that refuses it (below the 0.136.0 floor) fails the session's start, loudly.

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const record = (m) => fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  record({ method: m.method, params: m.params })
  if (m.method === 'skills/extraRoots/set') {
    if (process.env.FIXTURE_REFUSE_ROOTS === '1') return out({ id: m.id, error: { code: -32601, message: 'Method not found' } })
    return out({ id: m.id, result: {} })
  }
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'th-skills' }, model: 'm' } })
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

function start(env: Record<string, string>) {
  const raw = join(tmpdir(), `codex-skill-roots-${process.pid}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  dir = realpathSync(raw)
  const fake = join(dir, 'fake-codex.cjs')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  const recordPath = join(dir, 'record.jsonl')
  writeFileSync(recordPath, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_SKILL_ROOTS: undefined, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: recordPath, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, { result?: unknown; error?: { message?: string } }>()
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
  const reply = (id: number, what: string) =>
    awaitFact(what, () => responses.get(id), { producer: child })
  const asked = () =>
    readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; params?: unknown })
  return { send, reply, asked }
}

const opened = async (rig: ReturnType<typeof start>) => {
  await rig.reply(rig.send('initialize', { protocolVersion: 1, clientCapabilities: {} }), 'initialize')
  return rig.reply(rig.send('session/new', { cwd: dir, mcpServers: [] }), 'session/new')
}

describe('codex ACP bridge: installed Apps\' skills are registered as extra skill roots (#6387)', () => {
  it('registers the materializer\'s roots before the thread starts', async () => {
    const root = '/gugu/capability-packages/codex/skills/0123456789ab'
    const rig = start({ GUGU_CODEX_SKILL_ROOTS: JSON.stringify([root]) })
    expect((await opened(rig)).error).toBeUndefined()
    const methods = rig.asked().map((m) => m.method)
    expect(rig.asked().find((m) => m.method === 'skills/extraRoots/set')?.params).toEqual({ extraRoots: [root] })
    expect(methods.indexOf('skills/extraRoots/set')).toBeLessThan(methods.indexOf('thread/start'))
    expect(methods.indexOf('skills/extraRoots/set')).toBeGreaterThan(methods.indexOf('initialize'))
  })

  it('negative control: no skills, no such request', async () => {
    const rig = start({})
    expect((await opened(rig)).error).toBeUndefined()
    expect(rig.asked().map((m) => m.method)).toContain('thread/start')
    expect(rig.asked().map((m) => m.method)).not.toContain('skills/extraRoots/set')
  })

  it('a codex that refuses them fails the start loudly, never a session without its skills', async () => {
    const rig = start({ GUGU_CODEX_SKILL_ROOTS: JSON.stringify(['/gugu/x']), FIXTURE_REFUSE_ROOTS: '1' })
    const answer = await opened(rig)
    expect(answer.error?.message ?? '').toMatch(/Method not found/)
    expect(rig.asked().map((m) => m.method)).not.toContain('thread/start')
  })
})
