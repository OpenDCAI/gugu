import { expect, test } from 'vitest'

test('keeps Vitest assertion attribution intact', () => {
  expect('actual assertion value').toBe('expected assertion value')
})
