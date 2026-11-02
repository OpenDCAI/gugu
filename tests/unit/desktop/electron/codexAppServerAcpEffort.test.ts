// @@@vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { awaitFact } from '../../../support/awaitFact'

const ADAPTER = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')
const SOURCE = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
rl.on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined || !m.method) return
  fs.appendFileSync(process.env.FIXTURE_RECORD, JSON.stringify(m) + '\\n')
  let result = { data: [] }
  if (m.method === 'thread/start') result = { thread: { id: 'thread' }, model: 'a', reasoningEffort: JSON.parse(process.env.FIXTURE_EFFORT) }
  if (m.method === 'model/list') result = { data: [
    { id: 'a', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
    { id: 'b', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
    { id: 'no-efforts', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] },
    { id: 'no-default', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ] }
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')
})
`

it.each([null, 'medium'])('advertises the model default without making it an explicit thread override (effort=%s)', async (initialEffort) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-effort-'))
  const fake = join(dir, 'codex.cjs')
  const record = join(dir, 'requests.jsonl')
  writeFileSync(fake, SOURCE); chmodSync(fake, 0o755)
  writeFileSync(record, '')
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FIXTURE_RECORD: record, FIXTURE_EFFORT: JSON.stringify(initialEffort) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  type Reply = { result?: { configOptions?: Array<{ category: string; currentValue: string; options: Array<{ value: string }> }> }; error?: { code: number } }
  const responses = new Map<number, Reply>()
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) responses.set(m.id, m)
  })
  let nextId = 0
  const call = async (method: string, params: unknown) => {
    const id = ++nextId
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return awaitFact(method, () => responses.get(id), { producer: child })
  }
  const effort = (reply: Reply) => reply.result?.configOptions?.find(option => option.category === 'thought_level')
  const settings = () => readFileSync(record, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter(m => m.method === 'thread/settings/update').map(m => m.params)
  const set = (configId: string, value: string) => call('session/set_config_option', { sessionId: 'thread', type: 'id', configId, value })
  try {
    await call('initialize', { protocolVersion: 2, clientCapabilities: {} })
    const created = await call('session/new', { cwd: dir, mcpServers: [] })
    expect(created.error).toBeUndefined()
    expect(effort(created)).toMatchObject({ currentValue: initialEffort ?? 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] })
    expect(settings()).toEqual([])
    // A default follows the next model; an explicitly configured level stays selected.
    expect(effort(await set('model', 'b'))?.currentValue).toBe(initialEffort ?? 'low')
    expect(settings()).toEqual([{ threadId: 'thread', model: 'b' }])
    expect(effort(await set('effort', 'high'))?.currentValue).toBe('high')
    expect(settings().at(-1)).toEqual({ threadId: 'thread', effort: 'high' })
    const before = settings()
    expect((await set('effort', 'unoffered')).error?.code).toBe(-32602)
    expect(settings()).toEqual(before)
    expect(effort(await set('model', 'no-efforts'))).toBeUndefined()
    expect(effort(await set('model', 'no-default'))).toBeUndefined()
  } finally {
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed
    unlinkSync(fake); unlinkSync(record); rmdirSync(dir)
  }
})
