import { describe, expect, it } from 'vitest'
import { serverSupportsConfirmedRestart } from '../../../../packages/core/src/cloud/serverMachineHealth'

describe('confirmed server restart support', () => {
  it.each([null, undefined, 'local', '0.2.57', '0.2.58-beta.1055.1'])('does not offer an unsupported restart for %s', version => {
    expect(serverSupportsConfirmedRestart(version)).toBe(false)
  })

  it.each(['0.2.58-beta.1056.1', '0.2.58-beta.1057.1', '0.2.59-beta.1'])('allows a supported restart for %s', version => {
    expect(serverSupportsConfirmedRestart(version)).toBe(true)
  })
})
