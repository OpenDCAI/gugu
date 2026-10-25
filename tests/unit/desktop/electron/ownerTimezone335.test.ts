import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOwnerTimeZoneContext, ownerTimeZoneFromEnvironment, parseOwnerTimeZoneContext } from '../../../../apps/desktop/electron/server/owner-timezone'
import { getLocalTimeZone, getOwnerTimeZoneContext, setOwnerTimeZoneContext } from '../../../../apps/desktop/src/session/shared/core/automations/timezone'
import { resolveScheduleTrigger } from '../../../../apps/desktop/electron/session/main/core/automations/schedule-time'
import { runResume } from '../../../../apps/desktop/electron/server/resume-cli'
import { callAccountProcess } from '../../../../apps/desktop/electron/server/account-call'
import { startPtyAttachServer } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-server'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const context = { time_zone: 'Pacific/Auckland', source_device_id: 'phone',
  source_last_seen_at: '2026-10-25T06:00:00Z', read_at: '2026-10-25T06:01:00Z', status: 'device' as const }
afterEach(() => { setOwnerTimeZoneContext(null); vi.unstubAllEnvs() })

describe('hosted account owner time zone', () => {
  it('validates device facts, including unknown UTC and a cached source', () => {
    expect(parseOwnerTimeZoneContext(JSON.stringify(context))).toEqual(context)
    expect(parseOwnerTimeZoneContext({ ...context, status: 'cached' })).toMatchObject({ source_device_id: 'phone' })
    const unknown = { ...context, time_zone: 'UTC', source_device_id: null, source_last_seen_at: null, status: 'unknown' }
    expect(parseOwnerTimeZoneContext(unknown)).toEqual(unknown)
    for (const value of [{ ...context, time_zone: 'Mars/Base' }, { ...context, source_device_id: null },
      { ...unknown, time_zone: 'Pacific/Auckland' }, { ...context, read_at: 'invalid' }]) {
      expect(() => parseOwnerTimeZoneContext(value)).toThrow()
    }
  })

  it('changes only the hosted account environment and never accepts a desktop update', () => {
    const hostEnv = { TZ: 'UTC' }
    expect(() => applyOwnerTimeZoneContext(context, hostEnv)).toThrow('hosted account')
    expect(hostEnv).toEqual({ TZ: 'UTC' })
    const accountEnv = { GUGU_CLOUD_COMPUTER: '1', TZ: 'UTC' }
    applyOwnerTimeZoneContext(context, accountEnv)
    expect(accountEnv.TZ).toBe('Pacific/Auckland')
    expect(hostEnv.TZ).toBe('UTC')
    expect(getLocalTimeZone()).toBe('Pacific/Auckland')
    expect(ownerTimeZoneFromEnvironment(accountEnv)).toEqual(context)
    expect(ownerTimeZoneFromEnvironment({ GUGU_OWNER_TIME_ZONE_CONTEXT: JSON.stringify(context) })).toBeUndefined()
  })

  it('uses the new zone for new schedules and preserves explicitly supplied zones', () => {
    applyOwnerTimeZoneContext(context, { GUGU_CLOUD_COMPUTER: '1' })
    expect(resolveScheduleTrigger({ cron: '0 8 * * *' }).tz).toBe('Pacific/Auckland')
    expect(resolveScheduleTrigger({ cron: '0 8 * * *', tz: 'America/Toronto' }).tz).toBe('America/Toronto')
    expect(getOwnerTimeZoneContext()).toEqual(context)
  })

  it('applies a warm-resume context through the real account socket before inbox recovery', async () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
    vi.stubEnv('GUGU_OWNER_TIME_ZONE_CONTEXT', JSON.stringify(context))
    const dir = mkdtempSync(join(tmpdir(), 'gugu-owner-zone-'))
    const observed: string[] = []
    const server = await startPtyAttachServer(dir, { warn: vi.fn(), call: async (_type, payload) => {
      applyOwnerTimeZoneContext((payload as { timeZoneContext: unknown }).timeZoneContext, { GUGU_CLOUD_COMPUTER: '1' })
      observed.push(getLocalTimeZone())
      return { result: { resumed: true } }
    } })
    try {
      const account = { userId: 'owner', signedIn: true, dataDir: dir, email: null } as ServerAccount
      const deps = { accounts: () => [account], call: callAccountProcess }
      expect(await runResume(['--account', 'owner'], { stdout: new PassThrough(), stderr: new PassThrough() }, deps)).toBe(0)
      expect(observed).toEqual(['Pacific/Auckland'])
      vi.stubEnv('GUGU_OWNER_TIME_ZONE_CONTEXT', '{bad')
      expect(await runResume(['--account', 'owner'], { stdout: new PassThrough(), stderr: new PassThrough() }, deps)).toBe(2)
      expect(observed).toHaveLength(1)
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('updates the actual account clock in a fresh Node process without changing its parent', () => {
    const original = process.env.TZ
    const helper = resolve('apps/desktop/electron/server/owner-timezone.ts')
    const code = `const { applyOwnerTimeZoneContext } = require(${JSON.stringify(helper)});
      applyOwnerTimeZoneContext(JSON.parse(process.env.GUGU_OWNER_TIME_ZONE_CONTEXT));
      console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        hour: new Date('2026-10-25T00:00:00Z').getHours() }));`
    const result = execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', code], {
      env: { ...process.env, TZ: 'UTC', GUGU_CLOUD_COMPUTER: '1', GUGU_OWNER_TIME_ZONE_CONTEXT: JSON.stringify(context) }, encoding: 'utf8' })
    expect(JSON.parse(result)).toEqual({ zone: 'Pacific/Auckland', hour: 13 })
    expect(process.env.TZ).toBe(original)
  })
})
