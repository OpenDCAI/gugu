import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
const { nextProductTourPosition, previousProductTourPosition, parseProductTourPosition } = await import('../../../../apps/desktop/src/lib/productTour')

describe('product tour account progress', () => {
  it('forms one continuous seven-module, three-feature path', () => {
    let at: ReturnType<typeof nextProductTourPosition> = { phase: 'modules', index: 0 }
    const path = []
    while (at) { path.push(at); at = nextProductTourPosition(at) }
    expect(path).toHaveLength(10)
    expect(path[6]).toEqual({ phase: 'modules', index: 6 })
    expect(path[7]).toEqual({ phase: 'features', index: 0 })
    expect(path[9]).toEqual({ phase: 'features', index: 2 })
    expect(previousProductTourPosition(path[7])).toEqual(path[6])
    expect(previousProductTourPosition(path[0])).toBeNull()
  })
  it('distinguishes a new tour, valid resume and corrupt progress', () => {
    expect(parseProductTourPosition({})).toBeNull()
    expect(parseProductTourPosition({ productTour: { version: 2, phase: 'features', index: 2 } })).toEqual({ phase: 'features', index: 2 })
    expect(parseProductTourPosition({ productTour: { version: 2, phase: 'modules', index: 6 } })).toEqual({ phase: 'modules', index: 6 })
    for (const value of [null, {}, { version: 3, phase: 'modules', index: 0 }, { version: 2, phase: 'modules', index: 7 }, { version: 2, phase: 'features', index: 3 }, { version: 1, phase: 'features', index: 4 }, { version: 2, phase: 'modules', index: -1 }, { version: 2, phase: 'features', index: 0.5 }]) {
      expect(() => parseProductTourPosition({ productTour: value })).toThrow('Invalid product tour progress')
    }
  })
  it('resumes a tour saved with the retired modes film on the same or next film still shown', () => {
    const v1 = (index: number) => parseProductTourPosition({ productTour: { version: 1, phase: 'features', index } })
    expect([0, 1, 2, 3].map((index) => v1(index)?.index)).toEqual([0, 1, 1, 2])
    expect(parseProductTourPosition({ productTour: { version: 1, phase: 'modules', index: 6 } })).toEqual({ phase: 'modules', index: 6 })
  })
})
