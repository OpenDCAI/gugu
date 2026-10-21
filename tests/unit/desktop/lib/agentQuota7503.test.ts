import { describe, expect, it } from 'vitest'
import { agentQuotaReason, agentTurnFailureNeedsModelChoice } from '../../../../apps/desktop/src/lib/agentTurnFailure'

describe('quota notification reason', () => {
  it.each([
    ["You've hit your weekly limit. Resets Oct 21", 'weekly'],
    ['Monthly quota exceeded', 'monthly'],
    ['insufficient_quota', 'exhausted'],
    ['insufficient credits', 'exhausted'],
    ['HTTP 429 Too Many Requests', 'rate-limited'],
    ['rate_limit_error', 'rate-limited'],
    ['network timeout', null],
  ])('classifies %s without displaying raw text', (message, expected) => {
    expect(agentQuotaReason(message)).toBe(expected)
  })
  it('offers a model change for exhausted allowances, not every temporary rate limit', () => {
    expect(agentTurnFailureNeedsModelChoice('weekly limit reached')).toBe(true)
    expect(agentTurnFailureNeedsModelChoice('HTTP 429 Too Many Requests')).toBe(false)
    expect(agentTurnFailureNeedsModelChoice('API Error: 400 Model zoe/deepseek-v4.1-flash is not available')).toBe(true)
    expect(agentTurnFailureNeedsModelChoice('当前模型暂时不可用，请切换模型后重试。')).toBe(true)
  })
})
