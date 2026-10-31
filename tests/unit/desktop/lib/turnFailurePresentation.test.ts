import { describe, expect, it } from 'vitest'
import { turnFailurePresentation, turnFailureReasonFromError } from '@gugu/core/shared/turnFailurePresentation'

describe('turn failure presentation', () => {
  it.each([
    ['request timed out', 'timeout'], ['HTTP 403 forbidden', 'authentication'], ['fetch failed', 'network'],
    ['stream disconnected', 'offline'], ['HTTP 429 Too Many Requests', 'rateLimited'],
    ["You've hit your weekly limit", 'weeklyQuota'], ['Missing environment variable: SECRET', 'generic'], ['', 'timeout'],
  ] as const)('keeps the existing cause for %s', (raw, reason) => {
    expect(turnFailureReasonFromError(raw)).toBe(reason)
    expect(turnFailurePresentation(reason).bodyKey).toBe(`agent.turnFailure.${reason}`)
  })
  it('offers model settings only for the reasons those settings can resolve', () => {
    expect(turnFailurePresentation('network').actions).toEqual(['retry'])
    expect(turnFailurePresentation('authentication').actions).toEqual(['settings', 'retry'])
    expect(turnFailurePresentation('weeklyQuota').actions).toEqual(['model', 'retry'])
    expect(turnFailurePresentation('authentication').tone).toBe('danger')
    expect(turnFailurePresentation('network').tone).toBe('warn')
  })
})
