// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rt = vi.hoisted(() => {
  const handlers: Array<() => void> = []
  return { handlers, onSubscribed: undefined as undefined | (() => void), left: 0, joined: [] as string[], topics: [] as string[] }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ dataClient: { channel: (topic: string) => { rt.topics.push(topic); const channel = { on: (_: string, __: unknown, handler: () => void) => { rt.handlers.push(handler); return channel } }; return channel } } }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribeAuthenticatedRealtimeChannel: (create: () => unknown, label: string, options: { onSubscribed(): void }) => { rt.joined.push(label); rt.onSubscribed = options.onSubscribed; return create() },
  unsubscribeAuthenticatedRealtimeChannel: async () => { rt.left++ },
}))

import { act } from 'react'
import { holderOfflineText, useHolderBack } from '../../../../apps/desktop/src/lib/fileHost'
import { createNode, createReactHarness } from '../../../support/testHarness'

const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 0)) })

describe('useHolderBack', () => {
  const onBack = vi.fn()
  let ui: ReturnType<typeof createReactHarness>
  let offline = true
  const Waiting = ({ deviceId = 'holder' }: { deviceId?: string }) => { useHolderBack(deviceId, onBack, async () => offline); return null }
  beforeEach(() => { onBack.mockClear(); offline = true; rt.handlers.length = 0; rt.topics.length = 0; rt.joined.length = 0; rt.left = 0; ui = createReactHarness() })
  afterEach(() => ui.cleanup())
  const announced = async () => { rt.handlers.forEach((handler) => handler()); await settle() }
  it('holds one private topic per waited machine, only while waiting', async () => {
    await ui.render(createNode('div', {}, createNode(Waiting, {}), createNode(Waiting, {})))
    await settle()
    expect(rt.topics).toEqual(['gugu:holder:holder'])
    await ui.render(createNode('div', {}))
    await settle()
    expect(rt.left).toBe(1)
  })
  it('reads the truth on each join, for a return it missed, and when the machine announces itself', async () => {
    await ui.render(createNode(Waiting, {}))
    await settle()
    rt.onSubscribed!(); await settle()
    await announced()
    expect(onBack).not.toHaveBeenCalled()
    offline = false
    rt.onSubscribed!(); await settle()
    expect(onBack).toHaveBeenCalledTimes(1)
    await announced()
    expect(onBack).toHaveBeenCalledTimes(2)
  })
})

describe('holderOfflineText', () => {
  it('names whose machine it is, and only the machine when it is the reader\'s own', () => {
    expect(holderOfflineText({ machine: 'Studio', person: 'Ann', deviceId: 'd' })).toMatch(/Ann.*Studio/)
    const own = holderOfflineText({ machine: 'Studio', person: null, deviceId: 'd' })
    expect(own).toContain('Studio')
    expect(own).not.toContain('Ann')
  })
})
