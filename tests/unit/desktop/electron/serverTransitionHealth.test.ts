import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSupervisorHealth } from '../../../../apps/desktop/electron/server/server-health'
import { readBadVersions } from '../../../../apps/desktop/electron/server/server-startup'

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-transition-health-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('compatibility with already shipped upgrade readers', () => {
  it('writes the original supervisor heartbeat with the actual single-run PID', () => {
    writeSupervisorHealth(home, { version: '2.0.0', pid: process.pid, startedAt: 100 }, 150)
    const file = path.join(home, 'data/supervisor-health.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: '2.0.0', pid: process.pid, startedAt: 100, at: 150, confirmedRestart: true })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
  it('reads the preloader rollback registry without maintaining another failure list', () => {
    fs.mkdirSync(path.join(home, 'data'))
    fs.writeFileSync(path.join(home, 'data/bad-versions.json'), JSON.stringify({ '2.0.0': 123, '3.0.0': 'unknown', '../elsewhere': 456 }))
    expect(readBadVersions(home)).toEqual({ '2.0.0': 123 })
  })
})
