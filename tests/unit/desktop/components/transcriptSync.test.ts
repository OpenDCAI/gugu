import { expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { planHistorySync, splitActiveTurn } from '../../../../apps/desktop/src/components/assistant-ui/transcript-sync'

const turn = (id: string, settled = true) => ({ id, seq: 0, items: [], ...(settled ? { outcome: { kind: 'end_turn' } } : {}) }) as unknown as TranscriptTurn
const a = turn('a'), b = turn('b'), c = turn('c')

it('takes the unfinished last turn as the active one', () => {
  const open = turn('d', false)
  expect(splitActiveTurn([a, b, open])).toEqual({ settled: [a, b], active: open })
  expect(splitActiveTurn([a, b])).toEqual({ settled: [a, b], active: null })
  expect(splitActiveTurn([])).toEqual({ settled: [], active: null })
})

it('appends newly settled turns and prepends older ones, by reference', () => {
  expect(planHistorySync([a], [a, b, c])).toEqual({ op: 'append', turns: [b, c] })
  expect(planHistorySync([b, c], [a, b, c])).toEqual({ op: 'prepend', turns: [a] })
  expect(planHistorySync([a, b], [a, b])).toEqual({ op: 'none' })
  expect(planHistorySync([], [])).toEqual({ op: 'none' })
})

it('reseeds when a written turn was rewritten or removed', () => {
  const b2 = turn('b')
  expect(planHistorySync([a, b], [a, b2])).toEqual({ op: 'seed', turns: [a, b2] })
  expect(planHistorySync([a, b, c], [a, c])).toEqual({ op: 'seed', turns: [a, c] })
  expect(planHistorySync([], [a])).toEqual({ op: 'seed', turns: [a] })
})
