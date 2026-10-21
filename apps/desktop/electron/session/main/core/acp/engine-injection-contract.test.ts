import { describe, expect, it } from 'vitest'
import { requireInjectionContract } from '../../../../engine-injection-contract'

describe('Chat UI adapter platform injection contracts', () => {
  it.each(['codex', 'opencode'] as const)(
    'marks %s as a wired conversation-private adapter',
    (engineId) => {
      const contract = requireInjectionContract(engineId, 'cui')

      expect(contract).toMatchObject({
        wired: true,
        tokenLifetime: 'acpAdapterProcess',
        tokenReuseProbe: 'heldRecord',
      })
    },
  )
})
