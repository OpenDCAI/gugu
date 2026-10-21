// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useGroupCollabRemovedAgentGate, type GroupCollabRemovedAgentGate } from '../../../../apps/desktop/src/hooks/useGroupCollabRemovedAgentGate'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { GroupAgentItem, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
function agent(id: string): GroupAgentItem {
  return {
    id, role: 'member', type: 'agent', account_status: null,
    client: null, model_source: null,
    tools: [], permission_scope: null, current_task_id: null, current_task_title: null,
    last_action: null, last_active_at: null, listen_mode: 'active',
  }
}
function snapshot(agentIds: string[]): GroupCollabSnapshot {
  return {
    scheduler: { chat_id: 'c1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
    humans: [{ id: 'owner-1', role: 'owner', type: 'human', account_status: null }],
    agents: agentIds.map(agent),
    tasks: [],
    outputs: [],
  }
}
let gate: GroupCollabRemovedAgentGate
let liveStripResults: GroupCollabSnapshot[]
let memoryCache: Map<string, GroupCollabSnapshot>
function Probe({ userId }: { userId?: string }) {
  const cacheRef = useRef(memoryCache)
  gate = useGroupCollabRemovedAgentGate(
    userId,
    (updater) => {
      const next = typeof updater === 'function'
        ? (updater as (p: GroupCollabSnapshot) => GroupCollabSnapshot)(snapshot(['agent-x', 'agent-y']))
        : updater
      liveStripResults.push(next)
    },
    cacheRef,
  )
  return null
}
function dispatchRemoved(agentUserId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRemoved, { detail: { agentUserId } }))
  })
}
// @@@1877 群名册删除闸门的实际接线：window 事件监听 → 即时剔除当前 snapshot + 内存缓存 + 记入 id 集供 prune。
describe('#1877 useGroupCollabRemovedAgentGate — event listener + ref gate wiring', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(async () => {
    liveStripResults = []
    memoryCache = new Map([
      ['g-1', snapshot(['agent-x', 'agent-y'])],
      ['g-2', snapshot(['agent-z'])],
    ])
    harness = createReactHarness()
    await harness.render(createElement(Probe, { userId: 'owner-1' }))
  })
  afterEach(() => harness.cleanup())
  it('on ownedAgentRemoved: strips the live snapshot AND every memory-cache entry', () => {
    dispatchRemoved('agent-x')
    expect(liveStripResults.at(-1)?.agents.map((a) => a.id)).toEqual(['agent-y'])
    expect(memoryCache.get('g-1')?.agents.map((a) => a.id)).toEqual(['agent-y'])
    expect(memoryCache.get('g-2')?.agents.map((a) => a.id)).toEqual(['agent-z']) // untouched group unaffected
  })
  it('prune() filters removed ids from any later cache-derived snapshot (the reseed gate)', () => {
    dispatchRemoved('agent-x')
    expect(gate.prune(snapshot(['agent-x', 'agent-y'])).agents.map((a) => a.id)).toEqual(['agent-y'])
  })
  it('mergeAndPrune() defeats the SWR never-shrink merge (agent-x cannot survive via prev)', () => {
    dispatchRemoved('agent-x')
    const prev = snapshot(['agent-x', 'agent-y'])
    const freshWithoutX = snapshot(['agent-y'])
    expect(gate.mergeAndPrune(prev, freshWithoutX).agents.map((a) => a.id)).toEqual(['agent-y'])
  })
  // @@@2247 - mergeAndPrune now RECONCILES (allow-shrink): a member absent from the AUTHORITATIVE next is
  it('mergeAndPrune() allow-shrinks a removed-from-group member with NO removal event (#2247)', () => {
    const prev = snapshot(['agent-x', 'agent-y'])
    const authoritativeWithoutX = snapshot(['agent-y'])
    expect(gate.mergeAndPrune(prev, authoritativeWithoutX).agents.map((a) => a.id)).toEqual(['agent-y'])
  })
  it('is a no-op gate before any deletion', () => {
    const snap = snapshot(['agent-x'])
    expect(gate.prune(snap)).toBe(snap) // reference-stable no-op
  })
  it('clears the removed-id set when the signed-in user changes (never leak across accounts)', async () => {
    dispatchRemoved('agent-x')
    expect(gate.prune(snapshot(['agent-x'])).agents.map((a) => a.id)).toEqual([])
    await harness.render(createElement(Probe, { userId: 'owner-2' }))
    expect(gate.prune(snapshot(['agent-x'])).agents.map((a) => a.id)).toEqual(['agent-x'])
  })
})
