// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createSharedCaches } from './caches'

describe('SharedCaches.highlightWhenReady', () => {
  it('waits for a lazily loaded grammar, then caches the result', async () => {
    const caches = createSharedCaches()
    const code = 'SELECT id FROM users WHERE id = 1'

    expect(caches.highlight(code, 'sql')).toBeNull()
    const result = await caches.highlightWhenReady(code, 'sql')

    expect(result?.lines).toHaveLength(1)
    expect(caches.peekHighlight(code, 'sql')).toBe(result)
  })

  it('resolves null and reports it when the grammar fails to load', async () => {
    const failure = new Error('chunk failed to load')
    const caches = createSharedCaches({
      highlight: () => null,
      load: () => Promise.reject(failure)
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(caches.highlightWhenReady('func main() {}', 'go')).resolves.toBeNull()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('"go"'), failure)

    report.mockRestore()
  })

  it('works with an injected highlighter that has no load()', async () => {
    const caches = createSharedCaches({
      highlight: (code) => ({ rootStyle: '', lines: [[{ content: code }]] })
    })

    await expect(caches.highlightWhenReady('x', 'anything')).resolves.toEqual({
      rootStyle: '',
      lines: [[{ content: 'x' }]]
    })
  })
})
