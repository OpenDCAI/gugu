import { describe, expect, it, vi } from 'vitest'
import {
  configureEnvHttpProxy,
  readProxyEnv,
  redactProxyUrl
} from '../../../scripts/dev/proxy-config.mts'

describe('shared Node proxy configuration', () => {
  it('uses the same proxy environment precedence for both jobs', () => {
    expect(
      readProxyEnv({
        HTTPS_PROXY: 'http://upper.example:8080',
        https_proxy: 'http://lower.example:8080',
        HTTP_PROXY: 'http://fallback.example:8080'
      })
    ).toBe('http://lower.example:8080')
    expect(readProxyEnv({})).toBeUndefined()
  })

  it('removes proxy userinfo before logging', () => {
    expect(redactProxyUrl('http://demo-user:demo-pass@127.0.0.1:9')).toBe('http://127.0.0.1:9')
    expect(redactProxyUrl('http://proxy.internal:7890')).toBe('http://proxy.internal:7890')
  })

  it('never reflects an unparseable proxy value', () => {
    const secret = 'proxy-password-sentinel'
    const output = redactProxyUrl(`not a url // user:${secret}@host`)
    expect(output).toBe('[invalid proxy URL]')
    expect(output.includes(secret)).toBe(false)
  })

  it('rejects invalid credential URLs before proxy setup without reflecting credentials', async () => {
    const username = 'proxy-user-sentinel'
    const password = 'proxy-password-sentinel'
    const log = vi.fn()
    let message = ''

    try {
      await configureEnvHttpProxy({ https_proxy: `http://${username}:${password}@` }, log)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toBe('Invalid HTTP proxy configuration')
    expect(message.includes(username)).toBe(false)
    expect(message.includes(password)).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })
})
