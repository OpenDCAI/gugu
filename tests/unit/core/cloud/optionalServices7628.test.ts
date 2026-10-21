import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudComputerEnabled, parseOptionalServiceEnabled, platformModelsEnabled } from '@gugu/core/cloud/optionalServices'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('configured optional providers', () => {
  it('keeps existing builds enabled unless configured otherwise', () => {
    expect(parseOptionalServiceEnabled(undefined, 'provider')).toBe(true)
    expect(parseOptionalServiceEnabled('', 'provider')).toBe(true)
  })

  it('rejects a misspelled flag rather than silently enabling an unwanted service', () => {
    expect(() => parseOptionalServiceEnabled('disabled', 'provider')).toThrow('provider must be true or false')
  })

  it('permits official models with a local assistant while cloud hosting is disabled', () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER_ENABLED', 'false')
    vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'true')
    expect(cloudComputerEnabled()).toBe(false)
    expect(platformModelsEnabled()).toBe(true)
  })

  it('permits cloud hosting without selecting the official model provider', () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER_ENABLED', 'true')
    vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'false')
    expect(cloudComputerEnabled()).toBe(true)
    expect(platformModelsEnabled()).toBe(false)
  })

  it('uses the packaged configuration and allows an explicit runtime override', () => {
    vi.stubEnv('GUGU_CLOUD_COMPUTER_ENABLED', '')
    vi.stubGlobal('__GUGU_CLOUD_COMPUTER_ENABLED__', 'false')
    expect(cloudComputerEnabled()).toBe(false)
    vi.stubEnv('GUGU_CLOUD_COMPUTER_ENABLED', 'true')
    expect(cloudComputerEnabled()).toBe(true)
  })
})
