import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DUR_FAST_MS, DUR_MED_MS, DUR_SLOW_MS } from '../../../../apps/desktop/src/styles/motion'

const css = readFileSync(new URL('../../../../apps/desktop/src/styles/tokens.css', import.meta.url), 'utf8')

describe('JS motion durations project the CSS scale (#7333)', () => {
  it.each([
    ['fast', DUR_FAST_MS],
    ['med', DUR_MED_MS],
    ['slow', DUR_SLOW_MS],
  ] as const)('%s is the same duration in JS and CSS', (name, duration) => {
    const declarations = [...css.matchAll(new RegExp(`--dur-${name}:\\s*(\\d+)ms\\s*;`, 'g'))]
    expect(declarations, 'the CSS token must exist exactly once').toHaveLength(1)
    expect(duration).toBe(Number(declarations[0]![1]))
  })
})
