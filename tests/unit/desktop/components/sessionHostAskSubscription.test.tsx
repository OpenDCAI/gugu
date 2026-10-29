// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/** A remote host's Ask can be reread after a subscription is lost across a restart. */
const fx = vi.hoisted(() => ({
  settlements: [] as unknown[],
  snapshots: 0,
}))

vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  events: { on: () => () => undefined },
  rpc: {},
  rpcOn: () => ({
    sessionTimeline: {
      sessionSnapshot: async () => {
        fx.snapshots += 1
        return { ok: true, value: { settlements: fx.settlements, cursor: 'c' } }
      },
      sessionSubscribe: async () => ({ ok: true }),
      sessionUnsubscribe: async () => ({ ok: true }),
    },
  }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'cloud' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => null } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast: () => undefined }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: () => undefined, debug: () => undefined } }))

import { useSessionHostAsk } from '../../../../apps/desktop/src/session/renderer/features/extensions/use-session-host-ask'

function Probe() {
  const ask = useSessionHostAsk('task-1', 'app-install')
  return createNode('span', { 'data-ask': ask?.itemId ?? 'none' })
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

describe('a watched session’s host ask is read again, not left to a subscription that may be gone', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
    vi.useFakeTimers()
    fx.settlements = []
    fx.snapshots = 0
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })

  it('reads one snapshot and leaves later updates to the subscription', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await settle()
    expect(fx.snapshots).toBe(1)
  })
})
