import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestConfirmedVersionRestart, VERSION_SWITCH_FILE } from '../../../../packages/core/src/cloud/serverDesktopVersions'
import { describe, expect, it } from 'vitest'
import { serverSupportsConfirmedRestart } from '../../../../packages/core/src/cloud/serverMachineHealth'

describe('confirmed server restart capability', () => {
  it.each([null, undefined, {}, { server_confirmed_restart: false }])('does not infer support from an absent capability', value => {
    expect(serverSupportsConfirmedRestart(value as Parameters<typeof serverSupportsConfirmedRestart>[0])).toBe(false)
  })
  it('requires the explicit supervisor capability', () => {
    expect(serverSupportsConfirmedRestart({ server_confirmed_restart: true })).toBe(true)
  })
})


it('returns the exact host request timestamp written for a confirmed restart, including zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'confirmed-restart-'))
  try {
    const env = { GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dir }
    for (const at of [0, 1234]) {
      expect(requestConfirmedVersionRestart(env, '0.3.1', true, at)).toBe(at)
      expect(JSON.parse(readFileSync(join(dir, VERSION_SWITCH_FILE), 'utf8'))).toMatchObject({ at, target: '0.3.1', confirmed: true })
    }
    expect(requestConfirmedVersionRestart(env, '0.3.1', false, 5678)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, VERSION_SWITCH_FILE), 'utf8')).at).toBe(1234)
  } finally { unlinkSync(join(dir, VERSION_SWITCH_FILE)); rmdirSync(dir) }
})
