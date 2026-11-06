import { describe, expect, it } from 'vitest'
import { agentFailureReason } from '@gugu/core/shared/agentQuotaReason'
import { turnFailurePresentation } from '@gugu/core/shared/turnFailurePresentation'

describe('turn failure presentation', () => {
  it.each([
    ['request timed out', 'timeout'], ['HTTP 403 forbidden', 'authentication'], ['fetch failed', 'network'],
    ['HTTP 429 Too Many Requests', 'rateLimited'], ["You've hit your weekly limit", 'weeklyQuota'],
  ] as const)('the host classifies %s once; the card says that reason', (raw, reason) => {
    expect(agentFailureReason(raw)).toBe(reason)
    expect(turnFailurePresentation(reason).bodyKey).toBe(`agent.turnFailure.${reason}`)
  })
  it('offers model settings only for the reasons those settings can resolve', () => {
    expect(turnFailurePresentation('network').nextMessageKey).toBe('agent.turnFailure.card.nextMessage')
    for (const reason of ['deliveryRejected', 'outcomeUnknown', 'undelivered'] as const) expect(turnFailurePresentation(reason).nextMessageKey).toBeNull()
    expect(turnFailurePresentation('network').actions).toEqual(['retry'])
    expect(turnFailurePresentation('authentication').actions).toEqual(['settings', 'retry'])
    expect(turnFailurePresentation('weeklyQuota').actions).toEqual(['model', 'retry'])
    expect(turnFailurePresentation('authentication').tone).toBe('danger')
    expect(turnFailurePresentation('network').tone).toBe('warn')
  })
  it('offers no retry when no running instance holds the agent: resending lands on the same nobody', () => {
    expect(turnFailurePresentation('undelivered').actions).toEqual([])
  })
  it('names a terminal pre-admission rejection as not delivered and offers a fresh retry', () => {
    expect(turnFailurePresentation('deliveryRejected')).toMatchObject({
      titleKey: 'agent.turnFailure.card.deliveryRejected', bodyKey: 'agent.turnFailure.deliveryRejected', actions: ['retry'],
    })
  })
})
