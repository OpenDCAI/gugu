import { describe, expect, it } from 'vitest'
import { diagnosticSource, diagnosticStack, sanitizeDiagnosticFields } from '../../../../apps/desktop/shared/local-renderer-diagnostics'

describe('content-free local diagnostic protocol', () => {
  it('discards message bodies, user inputs, titles, URLs, arbitrary errors and credentials', () => {
    const privateText = 'private message and search query'
    const result = sanitizeDiagnosticFields({ event: 'escape', at: 12, message: privateText, value: privateText,
      title: privateText, error: privateText, accessToken: privateText, target: { textContent: privateText },
      handledBy: ['app-dialog', privateText], before: [{ id: 1, kind: 'dialog', title: privateText }] })
    expect(result).toEqual({ event: 'escape', at: 12, handledBy: ['app-dialog'], before: [{ id: 1, kind: 'dialog' }] })
    expect(JSON.stringify(result)).not.toContain(privateText)
  })

  it('keeps actual locations and strips query/fragment, frame names and private file paths', () => {
    expect(diagnosticSource('gugu-app://app/assets/main-abcd.js:12:44')).toBe('assets/main-abcd.js:12:44')
    expect(diagnosticSource('gugu-app://app/assets/main.js?query=private#title')).toBe('assets/main.js')
    expect(diagnosticSource('https://example.com/private/path?query=private')).toBe('unknown')
    expect(diagnosticSource('file:///Users/person/private.js:1:1')).toBe('unknown')
    expect(diagnosticStack('Error: private query\n at privateTitle (gugu-app://app/assets/main.js:1:2)\n at file:///private/code.js:3:4'))
      .toEqual(['assets/main.js:1:2'])
  })

  it('bounds nested arrays and rejects malformed or non-finite measurements', () => {
    const result = sanitizeDiagnosticFields({ event: 'memory', at: Infinity, usedHeapBytes: -1,
      totalHeapBytes: 1234, layers: Array.from({ length: 100 }, (_, id) => ({ id, kind: 'dialog' })),
      attribution: Array.from({ length: 100 }, () => ({ source: 'https://third.party/private', container: 'private title' })) })!
    expect(result.at).toBeUndefined()
    expect(result.usedHeapBytes).toBeUndefined()
    expect(result.totalHeapBytes).toBe(1234)
    expect(result.layers).toHaveLength(16)
    expect(result.attribution).toHaveLength(4)
    expect((result.attribution as unknown[])[0]).toEqual({ source: 'unknown', container: 'unknown' })
    expect(sanitizeDiagnosticFields({ event: 'private body' })).toBeNull()
  })
})
