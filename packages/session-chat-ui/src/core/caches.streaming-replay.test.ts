// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createParseCaches } from './caches'
import type { Block } from './markdown/document'

/** Characters handed to the markdown parser: what a streaming chunk costs, counted instead of timed (#6749). */
const parser = vi.hoisted(() => ({ chars: 0 }))
vi.mock('./markdown/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./markdown/parse')>()
  return {
    ...actual,
    parseMarkdownToBlocks: (...args: Parameters<typeof actual.parseMarkdownToBlocks>) => {
      parser.chars += args[1].length
      return actual.parseMarkdownToBlocks(...args)
    },
  }
})

/**
 * 8.7k characters of a real GLM thought (F47). Its sixth paragraph says "(wrap selection with **, etc.)" —
 * a literal `**` that never closes. Kept as .txt so no formatter rewrites the markdown. Resolved from this
 * file's path: vite rewrites `new URL('./…', import.meta.url)` into a served asset path.
 */
const THOUGHT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'glm-thought-literal-strong.txt'),
  'utf8'
)
const CHUNK = 64

/** Verbatim prose from finished paragraphs, first to last; the second is the literal `**` itself. */
const PROBES = [
  'generic keyword-based with strings, comments, numbers',
  '(wrap selection with **, etc.)',
  'Search over markdown source',
  'Could compute mapping by rendering incrementally',
  'Clean, correct, predictable.',
  'Include it.',
]

function visibleText(blocks: readonly Block[]): string {
  return blocks.map((block) => (block.kind === 'html' ? block.text : '')).join('\n')
}

describe('streaming a long real thought past a literal **', () => {
  it('re-parses only the growing paragraph, settles every finished one for good, and shows it', () => {
    const cache = createParseCaches()
    // The excerpt holds no code fence, so every blank line is a boundary the stream settles at.
    const paragraphEnds = [...THOUGHT.matchAll(/\n\n/gu)].map((match) => match.index + 2)
    const longestParagraph = Math.max(...THOUGHT.split('\n\n').map((paragraph) => paragraph.length + 2))
    const due = PROBES.map((probe) => ({ probe, at: THOUGHT.indexOf('\n\n', THOUGHT.indexOf(probe)) + 2 }))
    let previous: Block[] = []

    for (let end = CHUNK; end - CHUNK < THOUGHT.length; end += CHUNK) {
      const shown = THOUGHT.slice(0, end)
      const settled = cache.settledBlockCount('thought')
      parser.chars = 0
      const blocks = cache.parseBlocksStreaming('thought', shown)

      expect(parser.chars).toBeLessThanOrEqual(longestParagraph + CHUNK)
      for (let index = 0; index < settled; index += 1) expect(blocks[index]).toBe(previous[index])
      if (paragraphEnds.some((at) => at > end - CHUNK && at <= end)) {
        expect(cache.settledBlockCount('thought')).toBeGreaterThan(settled)
      }
      const visible = visibleText(blocks)
      for (const { probe, at } of due) if (shown.length >= at) expect(visible).toContain(probe)
      previous = blocks
    }
  })
})
