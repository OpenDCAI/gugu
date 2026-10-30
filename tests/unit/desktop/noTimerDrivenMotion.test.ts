import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Root contract: looping UI motion is CSS (keyframes on the compositor, paused through the shared animation
 * play-state variables when it cannot be seen). A short JS interval that steps a picture keeps the main thread busy
 * and the whole window producing frames for as long as it is mounted — the running grid loader (120 ms) and the
 * running glyph (80 ms) did exactly that on every running task.
 *
 * Guard: no `setInterval` with a literal period under 250 ms in UI sources. A short interval that is not motion is
 * listed here with its reason.
 */
const ROOTS = ['apps/desktop/src', 'packages/session-chat-ui/src', 'packages/session-shared/src']
const SHORT_MS = 250
const NOT_MOTION: Record<string, string> = {
  // cancels a pending CLI prepare promptly when the dialog is dismissed; draws nothing
  'apps/desktop/src/session/renderer/features/integrations/cli-tool-prepare.ts': 'cancellation poll',
}

const repo = path.resolve(import.meta.dirname, '../../..')
const sources = execFileSync('git', ['ls-files', '--', ...ROOTS], { cwd: repo, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file) && !/\.(test|spec|bench|stories)\./.test(file) && !file.includes('/tests/'))
// the callback may nest parentheses two deep; the period is the literal right before setInterval's own `)`
const SHORT_INTERVAL = /setInterval\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?),\s*(\d+(?:_\d+)*)\s*\)/g

describe('no timer-driven motion in UI sources', () => {
  it('has no setInterval shorter than 250 ms outside the listed non-motion polls', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const text = readFileSync(path.join(repo, file), 'utf8')
      for (const match of text.matchAll(SHORT_INTERVAL)) {
        const ms = Number(match[2]!.replaceAll('_', ''))
        if (ms < SHORT_MS && !NOT_MOTION[file]) offenders.push(`${file}: setInterval(…, ${ms})`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('still sees a short interval when there is one (positive control)', () => {
    const sample = 'const timer = setInterval(() => setFrame((f) => f + 1), 120);'
    expect([...sample.matchAll(SHORT_INTERVAL)].map((m) => Number(m[2]))).toEqual([120])
    // a named period followed later by an unrelated `, 0)` is not a short interval
    expect([...'timer = setInterval(() => this.tick(), TICK_MS); foo(a, 0)'.matchAll(SHORT_INTERVAL)]).toEqual([])
  })
})
