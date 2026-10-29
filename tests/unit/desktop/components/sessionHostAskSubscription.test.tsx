// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/** A remote host's Ask can be reread after a subscription is lost across a restart. */
const fx = vi.hoisted(() => ({
  settlements: [] as unknown[],
  snapshots: 0,
  respond: vi.fn(async (_input: unknown) => ({ ok: true, value: { accepted: true } })),
  open: vi.fn(async (_input: unknown) => undefined),
}))

vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  events: { on: () => () => undefined },
  rpc: { sessionTimeline: { sessionRespond: fx.respond } },
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
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openLinkTarget: fx.open }))
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: () => undefined, debug: () => undefined } }))

import { useHostAskBand, useSessionHostAsk } from '../../../../apps/desktop/src/session/renderer/features/extensions/use-session-host-ask'

function Probe() {
  const ask = useSessionHostAsk('task-1', 'app-install')
  return createNode('span', { 'data-ask': ask?.itemId ?? 'none' })
}

function HumanBand() {
  const band = useHostAskBand('task-1', { status: 'needs_user', detail: 'approval' })
  return createNode('div', {}, ...(band?.request.options ?? []).map(option =>
    createNode('button', { 'data-option': option.optionId, onClick: () => band?.resolve(option.optionId) }, option.label)))
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
    fx.respond.mockClear()
    fx.open.mockClear()
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

  it('opens the related App without settling; Done answers the original timeline once', async () => {
    fx.settlements = [{ itemId: 'human-1', state: 'pending', kind: 'permission',
      options: [{ optionId: 'complete', name: 'Done' }, { optionId: 'cancel', name: 'Cancel' }],
      origin: { source: 'app-human', payload: { title: 'Finish', extensionId: 'notes', appName: 'Notes', sessionId: 'task-1', tab: 'main' } } }]
    await harness.render(createNode(HumanBand, {})); await settle()
    expect(fx.snapshots).toBe(1)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-option="open-app"]')!.click() }); await settle()
    expect(fx.open).toHaveBeenCalledWith(expect.objectContaining({ extensionId: 'notes', tab: 'main', place: { session: 'task-1' } }))
    expect(fx.respond).not.toHaveBeenCalled()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-option="complete"]')!.click() }); await settle()
    expect(fx.respond).toHaveBeenCalledExactlyOnceWith({ conversationId: 'task-1', itemId: 'human-1', kind: 'permission', by: 'desktop', optionId: 'complete' })
  })
})
