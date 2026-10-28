import { afterEach, describe, expect, it, vi } from 'vitest'
import { mutateUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { fakeSettingsClient } from '../../../support/userSettingsTestDouble'

afterEach(() => vi.useRealTimers())

describe('account settings conditional mutation', () => {
  it('preserves concurrent App and unrelated settings in an existing row', async () => {
    const fake = fakeSettingsClient({ 'owner::user': { occupation: 'engineer' } })
    await Promise.all([
      mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, account_apps: { version: 1, apps: [] } })),
      mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, firstRunTerminal: true }))
    ])
    expect(fake.rows['owner::user']).toEqual({
      occupation: 'engineer', account_apps: { version: 1, apps: [] }, firstRunTerminal: true
    })
  })

  it('retries a competing first insert rather than overwriting the new row', async () => {
    const fake = fakeSettingsClient()
    await Promise.all([
      mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, account_apps: [] })),
      mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, productTour: 'done' }))
    ])
    expect(fake.rows['owner::user']).toEqual({ account_apps: [], productTour: 'done' })
  })

  it('advances the revision even under a frozen or earlier clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01'))
    const fake = fakeSettingsClient({ 'owner::user': {} })
    await mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, a: 1 }))
    await mutateUserSettingsConfig(fake.client, 'owner', 'user', config => ({ ...config, b: 2 }))
    expect(fake.upserts.map(row => row.updated_at)).toEqual(['2026-06-06T00:00:00.001Z', '2026-06-06T00:00:00.002Z'])
  })

  it('does not write a no-op and keeps accounts separate', async () => {
    const fake = fakeSettingsClient({ 'a::user': { installed: true } })
    await mutateUserSettingsConfig(fake.client, 'a', 'user', config => config)
    expect(fake.upserts).toHaveLength(0)
    await mutateUserSettingsConfig(fake.client, 'b', 'user', config => ({ ...config, own: true }))
    expect(fake.rows).toEqual({ 'a::user': { installed: true }, 'b::user': { own: true } })
  })

  it('fails closed for a client that can only perform blind writes', async () => {
    const fake = fakeSettingsClient()
    const client: SettingsTableClient = { from: table => {
      const { update: _update, insert: _insert, ...rest } = fake.client.from(table)
      return rest
    } }
    await expect(mutateUserSettingsConfig(client, 'owner', 'user', config => ({ ...config, app: true })))
      .rejects.toThrow('conditional writes')
    expect(fake.upserts).toHaveLength(0)
  })
})
