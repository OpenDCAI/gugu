import { describe, expect, it } from 'vitest'
import { createDefaultHighlighter, type HighlightResult, resolveAlias } from './highlighter'
import { LAZY_LANG_IDS } from './lazy-langs'

/**
 * How many distinct light-theme colours the first line uses. Plain text (no
 * grammar applied) comes out as a single colour, so > 1 means the grammar
 * actually tokenised the code.
 */
function colourCount(result: HighlightResult | null): number {
  const colours = new Set(
    (result?.lines[0] ?? []).map((token) => token.htmlStyle?.['--shiki-light'])
  )
  colours.delete(undefined)
  return colours.size
}

describe('resolveAlias', () => {
  it('maps common fence tags to a grammar id', () => {
    expect(resolveAlias('ts')).toBe('typescript')
    expect(resolveAlias('tsx')).toBe('tsx')
    expect(resolveAlias('rs')).toBe('rust')
    expect(resolveAlias('golang')).toBe('go')
    expect(resolveAlias('YML')).toBe('yaml')
    expect(resolveAlias('Dockerfile')).toBe('docker')
    expect(resolveAlias('c++')).toBe('cpp')
  })

  it('does not guess languages it has no grammar for', () => {
    expect(resolveAlias('cobol')).toBeUndefined()
    expect(resolveAlias('')).toBeUndefined()
    expect(resolveAlias(undefined)).toBeUndefined()
  })
})

describe('default highlighter', () => {
  it('highlights the bundled languages without loading anything', () => {
    const hl = createDefaultHighlighter()
    expect(hl.load?.('python')).toBeNull()
    expect(colourCount(hl.highlight('def answer(): return 42', 'python'))).toBeGreaterThan(1)
  })

  it('highlights a lazily loaded language once its grammar has arrived', async () => {
    const hl = createDefaultHighlighter()
    const code = 'fn main() { let answer: u32 = 42; }'

    expect(hl.highlight(code, 'rust')).toBeNull()
    const pending = hl.load?.('rs')
    expect(pending).toBeInstanceOf(Promise)
    await pending

    expect(colourCount(hl.highlight(code, 'rust'))).toBeGreaterThan(1)
    expect(hl.load?.('rust')).toBeNull()
  })

  it('shares one grammar load between concurrent requests', async () => {
    const hl = createDefaultHighlighter()
    const first = hl.load?.('go')
    expect(first).toBeInstanceOf(Promise)
    expect(hl.load?.('golang')).toBe(first)
    await first
    expect(colourCount(hl.highlight('func main() { return }', 'go'))).toBeGreaterThan(1)
  })

  it('loads the languages a grammar embeds (html pulls in css and js)', async () => {
    const hl = createDefaultHighlighter()
    await hl.load?.('html')
    const result = hl.highlight('<script>const answer = 42</script>', 'html')
    expect(colourCount(result)).toBeGreaterThan(1)
  })

  it('every pre-declared lazy grammar loads and highlights under its own id', async () => {
    const hl = createDefaultHighlighter()
    await Promise.all(LAZY_LANG_IDS.map((id) => hl.load?.(id)))
    const missing = LAZY_LANG_IDS.filter((id) => hl.highlight('x', id) === null)
    expect(missing).toEqual([])
  })

  it('returns null for an unknown language and has nothing to load', () => {
    const hl = createDefaultHighlighter()
    expect(hl.load?.('cobol')).toBeNull()
    expect(hl.highlight('DISPLAY "HI".', 'cobol')).toBeNull()
  })
})
