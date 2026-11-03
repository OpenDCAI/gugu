import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VERSION_RESTART_RPC } from '@gugu/core/cloud/serverMachineHealth'
import { parseMatchArgs, runMatchVersion, type MatchDeps } from '../../../../apps/desktop/electron/server/match-version-cli'
import { createServerUpdateStateWriter, readUpdateRecord } from '../../../../apps/desktop/electron/server/server-update-state'
import { startPtyAttachServer } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import type { Outcome } from '@gugu/core/shared/serverVersionOutcome'

let home: string
let deps: MatchDeps
let output: string[]
let clock: number
let accountData: string
const RECEIPT = 1234
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-update-cli-'))
  accountData = path.join(home, 'accounts/user/data')
  fs.mkdirSync(accountData, { recursive: true })
  for (const version of ['1.0.0', '2.0.0']) {
    fs.mkdirSync(path.join(home, 'versions', version, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'versions', version, 'bin/gugu-server'), '')
  }
  fs.symlinkSync('versions/1.0.0', path.join(home, 'current'))
  clock = 1000; output = []
  deps = { home, account: () => ({ userId: 'user', dataDir: accountData, dir: path.dirname(accountData), homeDir: home, email: null, addedAt: null, signedIn: true, signedOut: null }),
    runningVersion: () => '1.0.0', supervisorRunning: () => true, now: () => clock, waitMs: 2000,
    sleep: async () => { clock += 500 }, call: vi.fn(async () => ({ result: { requested: true, at: RECEIPT } })) }
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
const report = () => runMatchVersion(['--account', 'user', '--desktop', 'old:9_0_0', '--version', '9.0.0'], line => output.push(line), line => output.push(line), deps)
const apply = (version = '2.0.0', now = true) => runMatchVersion(['--account', 'user', '--apply', version, ...(now ? ['--now'] : [])], line => output.push(line), line => output.push(line), deps)
const ready = () => createServerUpdateStateWriter(home).set('ready', '2.0.0')

describe('released desktop compatibility uses installation facts and receipts', () => {
  it('accepts released argument shapes without turning the desktop report into a selection', () => {
    expect(parseMatchArgs(['--account=user', '--apply=2.0.0', '--now'])).toEqual({ mode: 'apply', account: 'user', version: '2.0.0', now: true })
    expect(parseMatchArgs(['--account', 'user', '--apply', '../bad'])).toHaveProperty('error')
  })
  it('reports current until a verified ready target exists; never records the desktop version', async () => {
    await report()
    expect(output.pop()).toBe('__GUGU_MATCH__ target=1.0.0 running=1.0.0 installed=1 supervisor=1')
    ready(); await report()
    expect(output.pop()).toBe('__GUGU_MATCH__ target=2.0.0 running=1.0.0 installed=1 supervisor=1')
    expect(fs.readdirSync(accountData)).toEqual([])
  })
  it.each(['downloading', 'switching', 'failed', 'idle'] as const)('does not advertise an unprepared %s target', async state => {
    createServerUpdateStateWriter(home).set(state, '2.0.0')
    await report()
    expect(output.pop()).toContain('target=1.0.0')
  })
  it('does not advertise a missing ready package', async () => {
    createServerUpdateStateWriter(home).set('ready', '3.0.0')
    await report(); expect(output.pop()).toContain('target=1.0.0')
  })
  it.each([['0.9.0', true], ['2.0.0', false], ['3.0.0', true]] as const)('refuses nonready/unconfirmed apply %s/%s in the old waiting category', async (version, now) => {
    ready(); expect(await apply(version, now)).toBe(8)
    expect(deps.call).not.toHaveBeenCalled()
    expect(fs.readdirSync(accountData)).toEqual([])
  })
  it('sends the exact ready target with confirmation and only accepts its matching A7 result', async () => {
    ready()
    deps.sleep = async () => {
      clock += 500
      createServerUpdateStateWriter(home).set('idle', '2.0.0', undefined, { lastOutcome: { kind: 'switched', target: '2.0.0', request: clock < 2000 ? RECEIPT - 1 : RECEIPT, at: clock } })
    }
    expect(await apply()).toBe(0)
    expect(deps.call).toHaveBeenCalledExactlyOnceWith(deps.accounts!()[0], VERSION_RESTART_RPC, { version: '2.0.0', confirmed: true })
    expect(clock).toBe(2000)
    expect(output.pop()).toBe('__GUGU_MATCH__ switched=2.0.0')
    expect(fs.readdirSync(accountData)).toEqual([])
  })
  it.each([
    { kind: 'rolledBack', bad: '2.0.0', back: '1.0.0', request: RECEIPT, at: 2000 },
    { kind: 'failed', target: '2.0.0', cause: 'boot', request: RECEIPT, at: 2000 },
    { kind: 'switched', target: '3.0.0', request: RECEIPT, at: 2000 },
  ] satisfies Outcome[])('does not report a failed or replaced request as switched ($kind)', async lastOutcome => {
    ready(); deps.sleep = async () => { clock += 500; createServerUpdateStateWriter(home).set('idle', '1.0.0', undefined, { lastOutcome }) }
    expect(await apply()).toBe(6)
    expect(output.join('\n')).not.toContain('__GUGU_MATCH__ switched=')
  })
  it('times out rather than accepting a different request or an uncorrelated acknowledgement', async () => {
    ready(); expect(await apply()).toBe(4)
    deps.call = vi.fn(async () => ({ result: { requested: true } }))
    expect(await apply()).toBe(6)
  })
  it('uses the existing local attach socket for the update RPC', async () => {
    ready(); delete deps.call
    const call = vi.fn(async (type, payload) => {
      expect(type).toBe(VERSION_RESTART_RPC); expect(payload).toEqual({ version: '2.0.0', confirmed: true })
      createServerUpdateStateWriter(home).set('idle', '2.0.0', undefined, { lastOutcome: { kind: 'switched', target: '2.0.0', request: RECEIPT, at: 2000 } })
      return { result: { requested: true, at: RECEIPT } }
    })
    const socket = await startPtyAttachServer(accountData, { warn: vi.fn(), call })
    try {
      expect(await apply()).toBe(0); expect(call).toHaveBeenCalledOnce()
      expect(readUpdateRecord(home)?.lastOutcome?.request).toBe(RECEIPT)
    } finally { await socket.close() }
  })
})
