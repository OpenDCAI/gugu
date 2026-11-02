import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVersionSwitchRequest } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { writeVersionPin } from '../../../../apps/desktop/electron/server/server-account-versions'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'

const U1 = '11111111-1111-4111-8111-111111111111'
const A = '0.2.58-fc-staging.aaaaaaaa'
const B = '0.2.58-fc-staging.bbbbbbbb'
const NOW = 1_800_000_000_000
let home: string
let clock: number
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cloud-package-1003-'))
  vi.stubEnv('GUGU_SERVER_HOME', home)
  clock = NOW
  install(A)
  install(B)
  signIn(U1)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
const data = (id = U1) => path.join(home, 'accounts', id, 'data')
function signIn(id: string) {
  fs.mkdirSync(data(id), { recursive: true })
  fs.writeFileSync(path.join(data(id), 'server-session.enc'), 'x')
}
function install(version: string) {
  const bin = path.join(home, 'versions', version, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gugu-server'), '#!/bin/sh\n')
}
function pin(version: string, id = U1) {
  writeVersionPin(data(id), { version, previous: null, at: clock })
}

describe('managed cloud accounts follow the running supervisor package', () => {
  it('refuses a managed target outside the supervisor package at once, without leaving a request to wait on', async () => {
    pin(B)
    const error = vi.fn()
    const sleep = vi.fn(async () => {})
    const rc = await runMatchVersion(['--account', U1, '--apply', A, '--now'], vi.fn(), error, {
      home, runningVersion: () => B, supervisorRunning: () => true, managedSupervisorVersion: () => B, now: () => clock, sleep,
    })
    expect(rc).toBe(6)
    expect(sleep).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`守护进程的包 ${B}`))
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`不能换到 ${A}`))
    expect(readVersionSwitchRequest(data(), clock)).toBeNull()
  })
})
