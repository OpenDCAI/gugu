import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
const { parseProductTourState, resumableStep, TOUR_STEPS, TOUR_FILMS } = await import('../../../../apps/desktop/src/lib/productTour')

describe('product tour account progress', () => {
  it('has the seven feature-bar steps in rail order and three films without the retired modes one', () => {
    expect(TOUR_STEPS).toEqual(['assistant', 'tasks', 'chats', 'contacts', 'library', 'apps', 'settings'])
    expect(TOUR_FILMS).toEqual(['split', 'contacts', 'report'])
  })
  it('distinguishes never seen, valid progress and corrupt progress', () => {
    expect(parseProductTourState({})).toBeNull()
    expect(parseProductTourState({ productTour: { version: 2, step: 'contacts', status: 'skipped' } })).toEqual({ step: 'contacts', status: 'skipped' })
    for (const value of [null, {}, [], { version: 3, step: 'assistant', status: 'done' }, { version: 2, step: 'modes', status: 'done' }, { version: 2, step: 'assistant', status: 'paused' }, { version: 1, phase: 'modules', index: 7 }, { version: 1, phase: 'features', index: 0.5 }]) {
      expect(() => parseProductTourState({ productTour: value })).toThrow('Invalid product tour progress')
    }
  })
  it('reads the first version: a bubble it stopped on can be continued, the film phase counts as seen', () => {
    expect(parseProductTourState({ productTour: { version: 1, phase: 'modules', index: 3 } })).toEqual({ step: 'contacts', status: 'skipped' })
    expect(parseProductTourState({ productTour: { version: 1, phase: 'features', index: 3 } })).toEqual({ step: 'settings', status: 'done' })
  })
  it('offers to continue only a tour that was stopped, not one that was finished or never started', () => {
    expect(resumableStep({ step: 'library', status: 'skipped' })).toBe('library')
    expect(resumableStep({ step: 'library', status: 'active' })).toBe('library')
    expect(resumableStep({ step: 'settings', status: 'done' })).toBeNull()
    expect(resumableStep(null)).toBeNull()
  })
})
