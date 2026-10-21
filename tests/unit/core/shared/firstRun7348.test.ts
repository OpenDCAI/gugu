import { describe, expect, it } from 'vitest'
import {
  OCCUPATION_OTHER_MAX,
  firstRunStage,
  occupationComplete,
  parseOccupation,
  withOccupation,
} from '@gugu/core/shared/firstRun'

describe('first run (#7348): which screen a new account sees', () => {
  it('done once the intro was finished, whatever the profile says', () => {
    expect(firstRunStage({ onboardedAt: '2026-10-16T00:00:00Z', occupation: null })).toBe('done')
  })
  it('profile screen until an occupation is set', () => {
    expect(firstRunStage({ onboardedAt: null, occupation: null })).toBe('profile')
    expect(firstRunStage({ onboardedAt: null, occupation: { key: 'research' } })).toBe('intro')
  })
  it('"other" without its sentence does not count as filled', () => {
    expect(occupationComplete({ key: 'other', text: '   ' })).toBe(false)
    expect(firstRunStage({ onboardedAt: null, occupation: { key: 'other', text: ' ' } })).toBe('profile')
    expect(firstRunStage({ onboardedAt: null, occupation: { key: 'other', text: '律师' } })).toBe('intro')
  })
})

describe('first run (#7348): occupation stored in user settings', () => {
  it('missing profile or occupation = not set', () => {
    expect(parseOccupation({})).toBeNull()
    expect(parseOccupation({ profile: {} })).toBeNull()
  })
  it('round-trips presets and "other"', () => {
    expect(parseOccupation(withOccupation({}, { key: 'design' }))).toEqual({ key: 'design' })
    expect(parseOccupation(withOccupation({}, { key: 'other', text: '  律师 ' }))).toEqual({ key: 'other', text: '律师' })
  })
  it('keeps unrelated keys in the same settings row (agent create defaults live there too)', () => {
    const next = withOccupation({ agent_create: { device: 'd1' }, profile: { keep: 1 } }, { key: 'student' })
    expect(next.agent_create).toEqual({ device: 'd1' })
    expect(next.profile).toEqual({ keep: 1, occupation: 'student' })
  })
  it('switching from "other" back to a preset drops the stale sentence', () => {
    const next = withOccupation(withOccupation({}, { key: 'other', text: '律师' }), { key: 'product' })
    expect(next.profile).toEqual({ occupation: 'product' })
  })
  it('caps the "other" sentence', () => {
    const next = withOccupation({}, { key: 'other', text: 'x'.repeat(OCCUPATION_OTHER_MAX + 10) })
    expect((next.profile as { occupationText: string }).occupationText).toHaveLength(OCCUPATION_OTHER_MAX)
  })
  it('a malformed stored value is an error, not "not set" (would silently re-ask the profile screen)', () => {
    expect(() => parseOccupation({ profile: 'x' })).toThrow(/malformed/)
    expect(() => parseOccupation({ profile: { occupation: 'astronaut' } })).toThrow(/malformed/)
    expect(() => parseOccupation({ profile: { occupation: 'other' } })).toThrow(/malformed/)
  })
})
