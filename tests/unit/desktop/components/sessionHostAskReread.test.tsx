// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/**
 * 另一台机器上的会话:那台重启过(云电脑睡醒、server 升级),订阅就没了、不会再推。Browser Use 页签一直看着这个任务的
 * 「请你登录 / 接手」,所以隔一会儿重读一份快照:新来的那一问出现,答完的那一问消失(10-28 实测:不重读就一直停在旧的)。
 * 没要重读的(会话页的提问条)照旧只读一次快照、再靠订阅。
 */
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

const loginAsk = { itemId: 'ask-1', state: 'pending', origin: { source: 'browser-assistance', payload: { kind: 'login', site: 'example.com' } } }

function Probe({ rereadMs }: { rereadMs?: number }) {
  const ask = useSessionHostAsk('task-1', 'browser-assistance', rereadMs ? { rereadMs } : {})
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

  it('an ask that arrives with no event shows up at the next re-read, and goes once it is answered', async () => {
    await harness.render(createNode(Probe, { rereadMs: 4000 }))
    await settle()
    expect(harness.container.querySelector('span')?.getAttribute('data-ask')).toBe('none')

    fx.settlements = [loginAsk]
    await act(async () => { vi.advanceTimersByTime(4000) })
    await settle()
    expect(harness.container.querySelector('span')?.getAttribute('data-ask')).toBe('ask-1')

    fx.settlements = [{ ...loginAsk, state: 'settled' }]
    await act(async () => { vi.advanceTimersByTime(4000) })
    await settle()
    expect(harness.container.querySelector('span')?.getAttribute('data-ask')).toBe('none')
  })

  it('without rereadMs it reads the snapshot once and leaves the rest to the subscription', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await settle()
    expect(fx.snapshots).toBe(1)
  })
})
