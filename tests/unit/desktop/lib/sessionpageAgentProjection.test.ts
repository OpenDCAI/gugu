import { describe, expect, it } from 'vitest'
import {
  parseProviderBlocker,
  parseProviderReviewGate,
  parseSessionpageAgentContext,
} from '../../../../apps/desktop/src/lib/sessionpageAgentProjection'

describe('session-page agent DM projection', () => {
  it('parses the mapped context (mapping + platform recovery) and preserves normal unmapped null', () => {
    const context = {
      projectId: 'project-1',
      sessionId: 'conversation-1',
      view: 'general' as const,
      platformRecovery: null,
      projectionError: null,
    }
    expect(parseSessionpageAgentContext(context)).toEqual(context)
    expect(parseSessionpageAgentContext(null)).toBeNull()
  })

  it('carries which view the session runs in (#7167); a bad value fails loudly, a missing one reads as unknown', () => {
    const base = { projectId: 'project-1', sessionId: 'conversation-1', platformRecovery: null, projectionError: null }
    expect(parseSessionpageAgentContext({ ...base, view: 'code' })?.view).toBe('code')
    expect(parseSessionpageAgentContext({ ...base, view: null })?.view).toBeNull()
    expect(() => parseSessionpageAgentContext({ ...base, view: 'pty' })).toThrow('view')
  })

  it('fails loudly for a partial coordinate or a corrupt projection error', () => {
    expect(() => parseSessionpageAgentContext({
      projectId: 'project-1',
      projectionError: null,
    })).toThrow('sessionId')
    expect(() => parseSessionpageAgentContext({
      projectId: 'project-1',
      sessionId: 'conversation-1',
      projectionError: false,
    })).toThrow('projection error')
  })

  it('reads the review gate and provider blocker the host feed carries, loudly rejecting unknown shapes', () => {
    expect(parseProviderReviewGate(null)).toBeNull()
    expect(parseProviderReviewGate('mcp')).toBe('mcp')
    expect(() => parseProviderReviewGate('hooks')).toThrow('review gate')
    expect(parseProviderBlocker(null)).toBeNull()
    expect(parseProviderBlocker({ kind: 'provider', reason: 'auth', message: 'User not found' }))
      .toEqual({ kind: 'provider', reason: 'auth', message: 'User not found' })
    expect(() => parseProviderBlocker({ kind: 'provider', reason: 'weather', message: 'x' })).toThrow('provider blocker')
  })
})
