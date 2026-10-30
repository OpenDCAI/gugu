import { describe, expect, it } from 'vitest'
import { coverageReport } from './coverage'
import type { SearchCoverage } from './types'

const read: SearchCoverage = { chatId: 'group', threadRootId: null, oldestSeq: 1, newestSeq: 200, exhausted: true }

describe('search coverage', () => {
  it('is complete only when every listed chat has an exhausted main timeline', () => {
    expect(coverageReport(['group'], [read]).complete).toBe(true)
    expect(coverageReport(['group', 'other'], [read])).toMatchObject({ complete: false, chats: [read, { chatId: 'other', exhausted: false }] })
    expect(coverageReport(['group'], [{ ...read, exhausted: false }]).complete).toBe(false)
  })
  it('does not count a thread stream as the chat timeline', () => {
    expect(coverageReport(['group'], [{ ...read, threadRootId: 'root' }]).complete).toBe(false)
  })
})
