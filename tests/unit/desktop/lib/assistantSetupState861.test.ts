// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSetupStep, subscribeSetupStep, writeSetupStep } from '../../../../apps/desktop/src/lib/assistantSetupState'

afterEach(() => window.localStorage.clear())

describe('local assistant setup stage (#861)', () => {
  it('keeps the setup page across identity arrival and restart until actual startup completes', () => {
    writeSetupStep('owner', 'shell')
    expect(readSetupStep('owner')).toBe('shell')
    expect(readSetupStep('other-owner')).toBeNull()
    writeSetupStep('owner', 'connect')
    expect(readSetupStep('owner')).toBe('connect')
  })

  it('notifies the existing shell subscriber on failure, retry and completion', () => {
    const stages: (string | null)[] = []
    const listener = vi.fn(() => stages.push(readSetupStep('owner')))
    const stop = subscribeSetupStep(listener)
    try {
      writeSetupStep('owner', 'shell')
      writeSetupStep('owner', 'shell')
      writeSetupStep('owner', 'connect')
      expect(stages).toEqual(['shell', 'shell', 'connect'])
    } finally { stop() }
  })
})
