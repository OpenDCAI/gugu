// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { awaitFact } from '../../../support/awaitFact'

const ADAPTER = resolve(__dirname, '../../../../apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
  let result = { data: [] }
  if (m.method === 'thread/start') result = { thread: { id: 'thread-permission' }, activePermissionProfile: ':danger-full-access' }
  if (m.method === 'permissionProfile/list') result = { data: [':read-only', ':workspace', ':danger-full-access', 'custom'].map(id => ({ id, allowed: true })) }
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')
})
`

let dir = ''
let adapter: ChildProcessWithoutNullStreams | undefined
afterEach(async () => {
  if (adapter && adapter.exitCode === null && adapter.signalCode === null) {
    const closed = new Promise((done) => adapter!.once('close', done))
    adapter.kill('SIGTERM')
    await closed
  }
  if (dir) rmSync(dir, { recursive: true, force: true })
})

it('hot-switches approval policy with each builtin profile while preserving native custom profiles', async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-permission-mode-')))
  const fake = join(dir, 'fake-codex.cjs')
  const record = join(dir, 'requests.jsonl')
  writeFileSync(fake, FAKE_CODEX)
  chmodSync(fake, 0o755)
  writeFileSync(record, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: record },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  adapter = child
  const responses = new Map<number, { result?: unknown; error?: { code: number } }>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m)
  })
  let nextId = 0
  const call = async (method: string, params: unknown) => {
    const id = ++nextId
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => responses.get(id), { producer: child })
  }
  const settings = () => readFileSync(record, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter((m) => m.method === 'thread/settings/update').map((m) => m.params)

  expect((await call('initialize', { protocolVersion: 1, clientCapabilities: {} })).error).toBeUndefined()
  expect((await call('session/new', {
    cwd: dir, mcpServers: [],
    _meta: { guguCodex: { permissionProfile: ':danger-full-access', threadStart: { approvalPolicy: 'never', sandbox: 'danger-full-access' } } },
  })).error).toBeUndefined()
  for (const [profile, approvalPolicy] of [
    [':workspace', 'on-request'],
    [':danger-full-access', 'never'],
    [':read-only', 'never'],
    [':workspace', 'on-request'],
  ]) {
    const response = await call('session/set_config_option', { sessionId: 'thread-permission', configId: 'mode', value: profile })
    expect(response.error).toBeUndefined()
    expect(settings().at(-1)).toEqual({ threadId: 'thread-permission', permissions: profile, approvalPolicy })
  }
  expect((await call('session/set_config_option', { sessionId: 'thread-permission', configId: 'mode', value: 'custom' })).error).toBeUndefined()
  expect(settings().at(-1)).toEqual({ threadId: 'thread-permission', permissions: 'custom' })
  const before = settings()
  expect((await call('session/set_config_option', { sessionId: 'thread-permission', configId: 'mode', value: 'missing' })).error?.code).toBe(-32602)
  expect(settings()).toEqual(before)
})
