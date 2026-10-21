// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createParseCaches } from './caches'

function textOf(cache: ReturnType<typeof createParseCaches>, id: string, value: string): string {
  return cache
    .parseBlocksStreaming(id, value)
    .flatMap((block) => (block.kind === 'html' ? [block.text] : []))
    .join('')
}

describe('streaming markdown emphasis boundaries', () => {
  it('defers an unfinished CJK strong marker instead of painting literal stars', () => {
    const cache = createParseCaches()

    expect(textOf(cache, 'answer', 'Rust **所有权（Ownership）')).toBe('')
    expect(textOf(cache, 'answer', 'Rust **所有权（Ownership）*')).toBe('')
    expect(textOf(cache, 'answer', 'Rust **所有权（Ownership）**')).toBe('Rust 所有权（Ownership）')
    const blocks = cache.parseBlocks('answer', 'Rust **所有权（Ownership）**')
    const html = blocks.find((block) => block.kind === 'html')
    expect(html?.kind === 'html' && html.html).toBe('<p>Rust <strong>所有权（Ownership）</strong></p>')
  })

  it('keeps ordinary exponent notation visible while waiting for emphasis', () => {
    const cache = createParseCaches()

    expect(textOf(cache, 'math', '2 ** 3 = 8')).toBe('2 ** 3 = 8')
  })

  it('settles a finished paragraph that keeps a literal ** and keeps streaming past it', () => {
    const cache = createParseCaches()

    expect(textOf(cache, 'toolbar', 'wrap the selection with **, etc.\n\nnext')).toBe(
      'wrap the selection with **, etc.next'
    )
    expect(cache.settledBlockCount('toolbar')).toBe(1)
  })

  it('does not hold back a table whose cell holds a literal ** (an unquoted glob)', () => {
    const cache = createParseCaches()

    expect(textOf(cache, 'glob', '| pattern |\n| --- |\n| src/**.ts |')).toContain('src/**.ts')
  })
})
