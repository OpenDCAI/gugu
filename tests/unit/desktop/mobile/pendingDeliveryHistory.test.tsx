// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { splitActiveTurn } from '@/components/assistant-ui/transcript-sync'
import { mergePendingDeliveryHistoryTurns } from '@/mobile/agent-watch/pending-delivery-history-turns'
import { usePendingDeliveryHistory } from '@/mobile/agent-watch/usePendingDeliveryHistory'

const rpc = vi.hoisted(() => ({ history: vi.fn() }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessions: { getStoredHistory: rpc.history } }) }))

const stored = (seq: number): TranscriptTurn => ({ id: `session:turn:s${seq}`, seq, initiator: 'user',
  items: [], outcome: { kind: 'done', reason: 'end_turn' } })
const running = (seq: number): TranscriptTurn => ({ id: `session:turn:${seq}`, seq, initiator: 'user', items: [
  { kind: 'message', id: 'new-client-input', seq: 0, role: 'user', text: 'new input', _meta: { guguClientMessageId: 'client-input' } },
] })
const unknown: PendingPrompt = { id: 'old-unknown', text: 'old delivered message', held: true, delivery: { state: 'unknown' } }

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('receipt history keeps the native live tail separate from store ordering', () => {
  it('preserves the current page by reference when no receipt pages were read', () => {
    const current = [stored(100), running(3)]
    expect(mergePendingDeliveryHistoryTurns(current, [])).toBe(current)
  })

  it.each([0, 3, 101])('keeps a restarted runtime seq %s active after old pages arrive', seq => {
    const active = running(seq), current = Object.freeze([stored(100), stored(101), active])
    const extra = Object.freeze([stored(2), stored(1)])
    const merged = mergePendingDeliveryHistoryTurns(current, extra)
    expect(merged.map(turn => turn.id)).toEqual(['session:turn:s1', 'session:turn:s2', 'session:turn:s100', 'session:turn:s101', active.id])
    expect(splitActiveTurn(merged).active).toBe(active)
    expect(splitActiveTurn(merged).settled).not.toContain(active)
    expect(current.at(-1)).toBe(active)
    expect(extra.map(turn => turn.seq)).toEqual([2, 1])
  })

  it('prefers the current page on overlap and does not duplicate the current live identity', () => {
    const latest = stored(100), active = running(3)
    const stale = { ...latest, items: running(0).items }
    const merged = mergePendingDeliveryHistoryTurns([latest, active], [stale, active])
    expect(merged).toEqual([latest, active])
    expect(merged[0]).toBe(latest)
    expect(merged[1]).toBe(active)
  })

  it('keeps a completed page entirely in durable order', () => {
    const current = [stored(100), stored(101)]
    const merged = mergePendingDeliveryHistoryTurns(current, [stored(2), stored(1)])
    expect(merged.map(turn => turn.seq)).toEqual([1, 2, 100, 101])
    expect(splitActiveTurn(merged).active).toBeNull()
  })
})

it('keeps new input and live replies active through real unknown-history resolution and commit', async () => {
  let resolveHistory!: (value: { turns: TranscriptTurn[]; nextCursor: null }) => void
  rpc.history.mockReturnValueOnce(new Promise(resolve => { resolveHistory = resolve }))
  const active = running(3), page = [stored(100), stored(101)]
  const { result, rerender } = renderHook(({ turns }) => usePendingDeliveryHistory({ deviceId: 'host', sessionId: 'session',
    local: false, enabled: true, ready: true, cursor: 100, turns, inputs: [unknown] }), { initialProps: { turns: [...page, active] } })
  await waitFor(() => expect(rpc.history).toHaveBeenCalledOnce())
  expect(splitActiveTurn(result.current.turns).active).toBe(active)
  await act(async () => { resolveHistory({ turns: [stored(1), stored(2)], nextCursor: null }) })
  expect(result.current.turns.map(turn => turn.id)).toEqual(['session:turn:s1', 'session:turn:s2', ...page.map(turn => turn.id), active.id])
  expect(splitActiveTurn(result.current.turns).active).toBe(active)

  const updated: TranscriptTurn = { ...active, items: [...active.items,
    { kind: 'message', id: 'live-reply', seq: 1, role: 'assistant', text: 'live answer' }] }
  rerender({ turns: [...page, updated] })
  expect(splitActiveTurn(result.current.turns).active).toBe(updated)
  expect(splitActiveTurn(result.current.turns).active?.items.map(item => item.id)).toEqual(['new-client-input', 'live-reply'])
  expect(rpc.history).toHaveBeenCalledOnce()

  const committed: TranscriptTurn = { ...stored(102), items: updated.items }
  rerender({ turns: [...page, committed] })
  expect(result.current.turns.map(turn => turn.seq)).toEqual([1, 2, 100, 101, 102])
  expect(splitActiveTurn(result.current.turns).active).toBeNull()
  expect(result.current.turns.at(-1)?.items).toBe(updated.items)
  expect(result.current.turns.some(turn => turn.id === active.id)).toBe(false)
})
