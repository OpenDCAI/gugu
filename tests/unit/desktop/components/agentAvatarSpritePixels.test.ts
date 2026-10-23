import { describe, expect, it } from 'vitest'
import { featherWingRoot } from '../../../../apps/desktop/src/components/agentAvatar/engine/spritePixels'

const strip = (alpha: number[]) => new Uint8ClampedArray(alpha.flatMap((a) => [90, 120, 80, a]))
const alphas = (data: Uint8ClampedArray) => [...data].filter((_, i) => i % 4 === 3)

describe('wing root feather', () => {
  it('fades only the inner edge, preserves fabric colour, and mirrors between wings', () => {
    const left = strip([255, 255, 255, 255, 255, 255])
    const right = left.slice()
    featherWingRoot(left, 6, 1, -1, 3)
    featherWingRoot(right, 6, 1, 1, 3)
    expect(alphas(left)).toEqual([255, 255, 255, 189, 66, 0])
    expect(alphas(right)).toEqual(alphas(left).reverse())
    expect([...left].filter((_, i) => i % 4 !== 3)).toEqual([...strip([0, 0, 0, 0, 0, 0])].filter((_, i) => i % 4 !== 3))
  })

  it('follows the curved root on each row and never fills transparent pixels', () => {
    const pixels = strip([255, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    featherWingRoot(pixels, 6, 2, -1, 2)
    expect(alphas(pixels)).toEqual([255, 255, 128, 0, 0, 0, 255, 255, 255, 255, 128, 0])
  })
})
