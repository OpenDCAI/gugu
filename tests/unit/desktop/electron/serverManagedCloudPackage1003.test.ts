import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMatchVersion } from '../../../../apps/desktop/electron/server/match-version-cli'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })
describe('controller-owned installations', () => {
  it('cannot be redirected by an old desktop to a different package', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-controller-cli-')); homes.push(home)
    const dataDir = path.join(home, 'accounts/user/data'); fs.mkdirSync(dataDir, { recursive: true })
    const call = vi.fn()
    const error = vi.fn()
    const rc = await runMatchVersion(['--account', 'user', '--apply', '1.0.0', '--now'], vi.fn(), error, {
      home, accounts: () => [{ userId: 'user', dataDir, dir: path.dirname(dataDir), homeDir: home, email: null, addedAt: null, signedIn: true, signedOut: null }],
      runningVersion: () => '2.0.0', supervisorRunning: () => true, call,
    })
    expect(rc).toBe(8)
    expect(call).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('1.0.0'))
    expect(fs.readdirSync(dataDir)).toEqual([])
  })
})
