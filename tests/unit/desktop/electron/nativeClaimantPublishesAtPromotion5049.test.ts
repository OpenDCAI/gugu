// #5049 — a provider-native claimant (opencode serve/attach, droid daemon) must not publish its
// delivery claim while its control channel is still booting.
//
// The failure this pins: `prepareSessionpageDeliveryOwner('native')` installs the local-session OFFLINE
// blocker, then the host awaits `startSession(...)`, then `promoteSessionpageDeliveryOwner` registers the
// native owner and removes the blocker in one synchronous turn. When `startSession` itself registered
// the binding, the ~4s serve boot exposed TWO live owners (blocker + half-started claim), and every
// delivery arriving in that window — the chat page's attachment row lands there because the upload
// runs first — died on `deliveryTargetFor`'s cardinality check: "expected at most one live owner,
// got 2" (owner reading 2026-09-05, mac1 9352; reproduced on dev tip c6f7a8cd, mac1 9385).
//
// Falsifiability: re-adding `this.register(binding)` at the top of `startSession` turns the two
// "while booting" cases red (the claim becomes visible, the router throws). The "after promotion" cases
// are the positive control — the claim must still exist once the channel is live, or the fix would be
// "never claim", which the router would report as an agent with no runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  releaseStart: null as null | (() => void),
  started: 0,
  admitted: null as string | null,
}))

// The serve transport is the process boundary; the test controls WHEN `start` resolves so the
// booting window is a real, observable state rather than a race.
vi.mock('../../../../apps/desktop/electron/sessionpage/opencode-serve-attach-transport', () => {
  class OpencodeServeSession {
    providerSessionId: string | null = null
    readonly url: string
    constructor(port: number) {
      this.url = `http://127.0.0.1:${port}`
    }
    start(resumeProviderSessionId: string | null): Promise<string> {
      transport.started += 1
      return new Promise<string>((resolve) => {
        transport.releaseStart = () => {
          this.providerSessionId = resumeProviderSessionId ?? 'ses_test0001'
          resolve(this.providerSessionId)
        }
      })
    }
    async injectPrompt(text: string) {
      return { turnId: `turn-${text.length}`, completion: Promise.resolve() }
    }
    async waitUntilReady(expectedProviderSessionId: string) {
      if (this.providerSessionId !== expectedProviderSessionId) throw new Error('native session mismatch')
      transport.admitted = expectedProviderSessionId
    }
    async abort() { return false }
    isTurnInFlight() { return false }
    isAlive() { return true }
    isTmuxHosted() { return false }
    detach() {}
    disposeSync() {}
    async dispose() {}
  }
  return {
    OpencodeServeSession,
    reserveLoopbackPort: async () => 43210,
    OPENCODE_TURN_COMPLETION_TIMEOUT_MS: 1000,
  }
})

import { OpencodeServeAttachSessionDelivery } from '../../../../apps/desktop/electron/sessionpage/opencode-serve-attach-delivery'
import { DroidDaemonSessionDelivery } from '../../../../apps/desktop/electron/sessionpage/droid-daemon-session-delivery'
import { SessionpageLocalDeliveryRouter } from '../../../../apps/desktop/electron/sessionpage/session-injection'
import {
  localSessionDeliveryTarget,
  registerOfflineLocalSessionDelivery,
  unregisterLocalSessionDeliveryForAgent,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import { promoteSessionpageDeliveryOwner } from '../../../../apps/desktop/electron/sessionpage/sessionpage-delivery-owner-registry'

const AGENT = 'agent-5049'
const SESSION = 'conv-5049'

/**
 * A daemon websocket that answers every JSON-RPC request with an empty result — enough for the
 * adapter's `add_user_message` + `resolve_queued_user_message` pair to complete, so the test can
 * exercise the ROUTER's path into this claimant rather than a real `droid daemon`.
 */
function fakeDaemonSocket() {
  const handlers = new Set<(raw: { toString(): string }) => void>()
  return {
    on(event: string, handler: (raw: { toString(): string }) => void) { if (event === 'message') handlers.add(handler) },
    off(event: string, handler: (raw: { toString(): string }) => void) { if (event === 'message') handlers.delete(handler) },
    send(payload: string) {
      const { id } = JSON.parse(payload) as { id: number }
      const reply = JSON.stringify({ jsonrpc: '2.0', id, result: {} })
      for (const handler of [...handlers]) handler(reply)
    },
    close() {},
  }
}

describe('native claimants publish their claim at promotion, never while booting (#5049)', () => {
  beforeEach(() => {
    transport.releaseStart = null
    transport.started = 0
    transport.admitted = null
    // What `prepareSessionpageDeliveryOwner('native', …)` leaves behind before the host boots the channel.
    registerOfflineLocalSessionDelivery(AGENT, { sessionId: SESSION, providerId: 'mimocode' })
  })
  afterEach(() => {
    unregisterLocalSessionDeliveryForAgent(AGENT)
  })

  describe('opencode serve/attach', () => {
    it('rejects a different registered native session and a different resume or fork request', async () => {
      const opencode = new OpencodeServeAttachSessionDelivery()
      const binding = {
        agentUserId: AGENT, sessionId: SESSION, providerId: 'opencode',
        cwd: '/tmp', command: 'opencode', env: {},
      }
      const starting = opencode.startSession(binding, null)
      await vi.waitFor(() => expect(transport.started).toBe(1))
      transport.releaseStart!()
      const handle = await starting
      opencode.register({ ...binding, nativeSessionId: handle.providerSessionId })
      await expect(opencode.waitUntilReady(SESSION)).resolves.toBeUndefined()
      expect(transport.admitted).toBe(handle.providerSessionId)
      await expect(opencode.startSession(binding, 'ses_other')).rejects.toThrow('cannot reuse')
      await expect(opencode.startSession(binding, null, handle.providerSessionId)).rejects.toThrow('cannot reuse')
      opencode.register({ ...binding, nativeSessionId: 'ses_other' })
      await expect(opencode.waitUntilReady(SESSION)).rejects.toThrow('native session mismatch')
      opencode.register(binding)
      await expect(opencode.waitUntilReady(SESSION)).rejects.toThrow('no registered native session')
      await opencode.dispose()
    })

    it('keeps the claim invisible while the serve boots, so the offline blocker is the sole owner', async () => {
      const opencode = new OpencodeServeAttachSessionDelivery()
      const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, opencode])
      const binding = {
        agentUserId: AGENT,
        sessionId: SESSION,
        providerId: 'mimocode',
        cwd: '/tmp',
        command: 'mimo',
        env: {},
      }
      const starting = opencode.startSession(binding, null)
      await vi.waitFor(() => expect(transport.started).toBe(1))

      // The booting window: a nudge / session-direct resolution arriving now must see ONE owner.
      expect(opencode.liveSessionIdByAgent(AGENT)).toBeNull()
      expect(opencode.deliveryKeyForSession(SESSION)).toBeNull()
      expect(router.deliveryTargetFor(AGENT)).toBe(localSessionDeliveryTarget)
      // …and that owner answers not-live (cursor untouched; the session-live pull delivers later).
      await expect(router.injectForAgent(AGENT, { id: 'msg-1', text: 'hello' })).resolves.toBe('not-live')

      transport.releaseStart!()
      const handle = await starting
      expect(handle).toEqual({ url: 'http://127.0.0.1:43210', providerSessionId: 'ses_test0001' })
      // Still not published: `startSession` returning is not promotion.
      expect(opencode.liveSessionIdByAgent(AGENT)).toBeNull()
    })

    it('after promotion the serve claimant is the sole owner and declares its cell to the router', async () => {
      const opencode = new OpencodeServeAttachSessionDelivery()
      const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, opencode])
      const binding = {
        agentUserId: AGENT,
        sessionId: SESSION,
        providerId: 'mimocode',
        cwd: '/tmp',
        command: 'mimo',
        env: {},
      }
      const starting = opencode.startSession(binding, null)
      await vi.waitFor(() => expect(transport.started).toBe(1))
      transport.releaseStart!()
      const handle = await starting

      promoteSessionpageDeliveryOwner(AGENT, () => opencode.register({ ...binding, nativeSessionId: handle.providerSessionId }))

      expect(router.deliveryTargetFor(AGENT)).toBe(opencode)
      expect(opencode.liveSessionIdByAgent(AGENT)).toBe(SESSION)
      expect(localSessionDeliveryTarget.liveSessionIdByAgent(AGENT)).toBeNull()
      // Q2 of #5049: the route log used to print providerId/surface/timing = undeclared for this leg.
      expect(opencode.sessionProviderSurface(SESSION)).toEqual({ providerId: 'mimocode', surface: 'tui' })
      // The declared cell resolves to idle-only (opencode/mimocode tui carry no injection tier), which the
      // router only accepts from a channel with an admission entry — the same serve receipt, exposed as such.
      await expect(router.injectForAgent(AGENT, { id: 'msg-2', text: 'hello' })).resolves.toBe('accepted')
    })
  })

  describe('droid daemon', () => {
    it('keeps the claim invisible while the daemon boots and publishes it only at promotion', async () => {
      const droid = new DroidDaemonSessionDelivery()
      // ONE deferred daemon shared by every ensureDaemon call — the real adapter caches its daemon per
      // conversation, so a per-call promise would leave the later injection awaiting something nobody resolves.
      let releaseDaemon: (() => void) | null = null
      const daemon = new Promise((resolve) => {
        releaseDaemon = () => resolve({ child: { kill() {} }, port: 30001, socket: fakeDaemonSocket() })
      })
      vi.spyOn(droid as unknown as { ensureDaemon: () => Promise<unknown> }, 'ensureDaemon')
        .mockImplementation(() => daemon)
      const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, droid])
      const binding = { agentUserId: AGENT, sessionId: SESSION, providerId: 'droid', providerSessionId: 'ses-d', cwd: '/tmp' }

      const starting = droid.startSession(binding)
      await vi.waitFor(() => expect(releaseDaemon).not.toBeNull())
      expect(droid.liveSessionIdByAgent(AGENT)).toBeNull()
      expect(router.deliveryTargetFor(AGENT)).toBe(localSessionDeliveryTarget)

      releaseDaemon!()
      await expect(starting).resolves.toMatchObject({ FACTORY_DAEMON_PORT: '30001' })
      expect(droid.liveSessionIdByAgent(AGENT)).toBeNull()

      promoteSessionpageDeliveryOwner(AGENT, () => droid.register(binding))
      expect(router.deliveryTargetFor(AGENT)).toBe(droid)
      expect(droid.sessionProviderSurface(SESSION)).toEqual({ providerId: 'droid', surface: 'tui' })
      // Declaring the cell CHANGES how the router treats this leg: droid×tui declares no injection
      // tier ⇒ idle-only ⇒ the router demands an admission entry and throws
      // "lacks detached injection admission" without one. droid has no product-面 rig on mac1, so the
      // whole chain — declaration resolves, admission entry satisfies the tier, bytes are accepted — is
      // proven here rather than assumed.
      await expect(router.injectForAgent(AGENT, { id: 'msg-d', text: 'hello' })).resolves.toBe('accepted')
    })
  })

  // spec idle-reclaim:停会话(session_stop / 闲置回收)之后,下一条消息要能按原会话把它叫醒 —— 靠的是停的那一刻
  // 把投递交还给离线占位(宿主按原 conversation 重开它)。此前 opencode 停后一个属主都没有(投递直接失败、无人唤醒),
  // droid 根本没登记停机清理(daemon 不退、旧认领还在)。
  describe('a stop hands delivery back to the wakeable offline placeholder', () => {
    async function promotedOpencode() {
      const opencode = new OpencodeServeAttachSessionDelivery()
      const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, opencode])
      const binding = {
        agentUserId: AGENT, sessionId: SESSION, providerId: 'mimocode',
        cwd: '/tmp', command: 'mimo', env: {},
      }
      const starting = opencode.startSession(binding, null)
      await vi.waitFor(() => expect(transport.started).toBe(1))
      transport.releaseStart!()
      const handle = await starting
      promoteSessionpageDeliveryOwner(AGENT, () => opencode.register({ ...binding, nativeSessionId: handle.providerSessionId }))
      expect(router.deliveryTargetFor(AGENT)).toBe(opencode)
      return { opencode, router }
    }

    it('opencode/mimocode: teardown leaves exactly the offline placeholder, which the host can wake', async () => {
      const { opencode, router } = await promotedOpencode()
      await opencode.teardownSession(SESSION)
      expect(opencode.liveSessionIdByAgent(AGENT)).toBeNull()
      expect(router.deliveryTargetFor(AGENT)).toBe(localSessionDeliveryTarget)
      expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
    })

    it('negative control: releasing the claim without the hand-back leaves no owner at all', async () => {
      const { opencode, router } = await promotedOpencode()
      await opencode.unregisterSession(SESSION)
      expect(router.deliveryTargetFor(AGENT)).toBeNull()
    })

    it('droid: teardown stops the daemon and leaves exactly the offline placeholder', async () => {
      const droid = new DroidDaemonSessionDelivery()
      const socket = { ...fakeDaemonSocket(), close: vi.fn() }
      vi.spyOn(droid as unknown as { ensureDaemon: () => Promise<unknown> }, 'ensureDaemon')
        .mockImplementation(async () => {
          const daemon = { owned: null, backend: null, port: 30002, socket }
          ;(droid as unknown as { daemons: Map<string, unknown> }).daemons.set(SESSION, daemon)
          return daemon
        })
      const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget, droid])
      const binding = { agentUserId: AGENT, sessionId: SESSION, providerId: 'droid', providerSessionId: 'ses-d', cwd: '/tmp' }
      await droid.startSession(binding)
      promoteSessionpageDeliveryOwner(AGENT, () => droid.register(binding))
      expect(router.deliveryTargetFor(AGENT)).toBe(droid)

      await droid.teardownSession(SESSION)
      expect(droid.liveSessionIdByAgent(AGENT)).toBeNull()
      expect(socket.close).toHaveBeenCalled()
      expect(router.deliveryTargetFor(AGENT)).toBe(localSessionDeliveryTarget)
      expect(router.sessionIdForAgent(AGENT)).toBe(SESSION)
    })
  })
})
