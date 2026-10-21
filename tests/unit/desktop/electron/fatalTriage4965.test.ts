import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CRASH_LOG_BASENAME,
  classifyFatal,
  recordFatalSync,
} from '../../../../apps/desktop/electron/lib/fatal-triage'
const withCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code })
describe('classifyFatal — 环境故障', () => {
  it.each<readonly [string, () => unknown]>([
    ['Chromium net::ERR', () => new Error('net::ERR_NETWORK_IO_SUSPENDED')],
    ['Chromium wrapped ERR', () => new Error('request failed: net::ERR_CONNECTION_RESET')],
    ['libuv ECONNRESET', () => withCode('read ECONNRESET', 'ECONNRESET')],
    ['libuv EAI_AGAIN', () => withCode('getaddrinfo EAI_AGAIN db.example', 'EAI_AGAIN')],
    ['AbortSignal timeout', () => Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })],
    ['undici fetch cause', () => Object.assign(new TypeError('fetch failed'), {
      cause: withCode('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'),
    })],
    ['all-network AggregateError', () => new AggregateError([
      withCode('connect ECONNREFUSED ::1:443', 'ECONNREFUSED'),
      withCode('connect EHOSTUNREACH 10.0.0.1:443', 'EHOSTUNREACH'),
    ])],
  ])('%s is an environment failure', (_label, makeError) => {
    expect(classifyFatal(makeError())).toBe('environment')
  })
})
describe('classifyFatal — 缺陷(不许放行)', () => {
  it.each<readonly [string, () => unknown]>([
    ['ordinary TypeError', () => new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['ordinary Error', () => new Error('session-page status bridge is unavailable')],
    ['domain error with network cause', () => {
      class RuntimeAuthExpiredError extends Error { override name = 'RuntimeAuthExpiredError' }
      const domain = new RuntimeAuthExpiredError('Session permanently lost')
      ;(domain as Error & { cause?: unknown }).cause = withCode('read ECONNRESET', 'ECONNRESET')
      return domain
    }],
    ['mixed AggregateError', () => new AggregateError([
      withCode('connect ECONNREFUSED ::1:443', 'ECONNREFUSED'),
      new TypeError('handler is not a function'),
    ])],
    ['empty AggregateError', () => new AggregateError([])],
    ['EACCES', () => withCode('EACCES: permission denied', 'EACCES')],
    ['ENOENT', () => withCode('ENOENT: no such file', 'ENOENT')],
    ['EPIPE', () => withCode('write EPIPE', 'EPIPE')],
    ['Electron channel closed', () => new Error('Channel closed')],
    ['non-Error string', () => 'net::ERR_CONNECTION_RESET'],
    ['non-Error undefined', () => undefined],
    ['self-referential cause', () => {
      const loop = new TypeError('fetch failed')
      ;(loop as Error & { cause?: unknown }).cause = loop
      return loop
    }],
  ])('%s remains a defect', (_label, makeError) => {
    expect(classifyFatal(makeError())).toBe('defect')
  })
})
describe('recordFatalSync — 崩溃现场必须落盘', () => {
  it('同步写进 append-only 的崩溃文件,第二条不覆盖第一条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-crash-'))
    recordFatalSync({ dir, verdict: 'defect', source: 'uncaughtException', err: new Error('first') })
    recordFatalSync({ dir, verdict: 'environment', source: 'unhandledRejection', err: new Error('net::ERR_CONNECTION_RESET') })
    const lines = readFileSync(join(dir, CRASH_LOG_BASENAME), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const [first, second] = lines.map((line) => JSON.parse(line))
    expect(first).toMatchObject({ verdict: 'defect', source: 'uncaughtException', message: 'first' })
    expect(second).toMatchObject({ verdict: 'environment', source: 'unhandledRejection' })
    expect(first.stack).toContain('Error: first')
    expect(first.pid).toBe(process.pid)
  })
  it('目录不存在时自己建', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gugu-crash-')), 'nested', 'logs')
    recordFatalSync({ dir, verdict: 'defect', source: 'uncaughtException', err: new Error('boom') })
    expect(existsSync(join(dir, CRASH_LOG_BASENAME))).toBe(true)
  })
  it('记下 cause,排障时不用再猜包装里是什么', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-crash-'))
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: withCode('read ECONNRESET', 'ECONNRESET'),
    })
    recordFatalSync({ dir, verdict: 'environment', source: 'uncaughtException', err: wrapped })
    const entry = JSON.parse(readFileSync(join(dir, CRASH_LOG_BASENAME), 'utf8').trim())
    expect(entry.cause).toMatchObject({ message: 'read ECONNRESET' })
  })
  it('dir 为 null 时不写,也不抛', () => {
    expect(() => recordFatalSync({ dir: null, verdict: 'defect', source: 'uncaughtException', err: new Error('x') })).not.toThrow()
  })
  it('落盘失败不抛 —— 正在处理的已经是一个崩溃,不能再抛第二个', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gugu-crash-')), 'not-a-dir')
    recordFatalSync({ dir: file, verdict: 'defect', source: 'uncaughtException', err: new Error('x') })
    expect(() =>
      recordFatalSync({ dir: join(file, CRASH_LOG_BASENAME), verdict: 'defect', source: 'uncaughtException', err: new Error('y') }),
    ).not.toThrow()
  })
})
