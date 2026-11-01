import { describe, it } from 'vitest'
import { invariantCases, transitionCases, verifyMatrix } from './sessionLife/cases'

describe('session-life contract v3', () => {
  for (const c of transitionCases) it(`row ${c.row}: ${c.name}`, c.run)
  for (const c of invariantCases) it(c.name, c.run)
  it('rejects every undefined same-generation state/event pair and discards obsolete generations', verifyMatrix)
})
