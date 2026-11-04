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
