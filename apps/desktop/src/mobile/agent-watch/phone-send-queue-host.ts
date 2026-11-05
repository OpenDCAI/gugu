import type { SessionInput } from '@/lib/sessionInputOutbox'
import { releaseQueuedSessionInput, state, subscribeSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { rendererLogger } from '@/lib/log'
import { subscribeCachedDevices } from '@/store/devicesCache'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { directoryDevices, liveDeviceSessions, requestPhoneTaskDirectory, subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { sessionLifeViewChannel, sessionTurnSettledChannel } from '@/session/shared/core/sessions/sessionEvents'
import { phoneTimelineClient } from '../local-agent/phoneTimelineClient'
import * as remote from './sessionpage-rpc'
import { startPhoneSendQueueObserver, type PhoneQueueSource } from './phone-send-queue-observer'
import type { SessionpageTimelineClient } from './use-timeline-session'

/** Mobile custody observes only held queues, using the phone's existing authenticated timeline transport. */
export function watchPhoneSessionSendQueues(accountId: string, options?: { phoneHostsOnly: true }): () => void {
  const deviceOf = (input: SessionInput) => directoryDevices().find(device => device.device_id === input.deviceId)
  const current = () => state().valid() && state().accountId === accountId
  let retryPending = false
  const report = (error: unknown) => {
    retryPending = true
    rendererLogger('mobile/send-queue').warn({ error: String(error) }, 'Could not release composer queue')
  }
  const available = (input: SessionInput) => {
    const device = deviceOf(input)
    if (!device || device.is_online === false) return false
    if (options?.phoneHostsOnly && !isPhoneDevice(device)) return false
    if (!isPhoneDevice(device)) return true
    const directory = liveDeviceSessions()[device.device_id]
    return isAgentHostDevice(device) && directory?.cached === false && directory.connected === true
  }
  const observe = (input: SessionInput, changed: () => void): PhoneQueueSource => {
    const device = deviceOf(input)!
    const phone = isPhoneDevice(device)
    const client: SessionpageTimelineClient = phone ? phoneTimelineClient : remote
    const deviceId = device.device_id, sessionId = input.sessionId
    const subscriptionId = `send-queue:${crypto.randomUUID()}`
    let closed = false
    let subscribed = false
    let connected = true
    let epoch = 0
    const failedSettlements = new Set<string>()
    let queuedIds = ''
    let replying = false
    const queueIds = (prompts: { id: string }[] | undefined) => JSON.stringify((prompts ?? []).map(prompt => prompt.id))
    const stopEvents = client.subscribeSessionEvents(deviceId, subscriptionId, result => {
      // Streaming text does not change whether the foreground has completed.
      const nextQueue = result.ok ? queueIds(result.batch.queuedPrompts) : ''
      const queueChanged = nextQueue !== queuedIds
      queuedIds = nextQueue
      const nextReplying = result.ok && result.batch.liveReply !== undefined ? Boolean(result.batch.liveReply) : replying
      const replyChanged = nextReplying !== replying
      replying = nextReplying
      if (!result.ok || queueChanged || replyChanged || result.batch.settlements.length > 0 || result.batch.turns.some(turn => turn.outcome)) changed()
    })
    const stopErrors = client.subscribeSessionErrors?.(deviceId, subscriptionId, error => { connected = false; report(error); changed() })
    const stopLink = client.onLinkChange(deviceId, open => {
      epoch++
      connected = open
      if (open) subscribed = false
      changed()
    })
    const stopLife = phone ? () => {} : remote.onMachineEvent(deviceId, sessionLifeViewChannel, view => {
      if (view.sessionId === sessionId) changed()
    })
    const stopSettled = phone ? () => {} : remote.onMachineEvent(deviceId, sessionTurnSettledChannel, receipt => {
      if (receipt.sessionId !== sessionId) return
      if (receipt.status === 'failed') failedSettlements.add(receipt.referenceId)
      else failedSettlements.delete(receipt.referenceId)
      changed()
    })
    return {
      async read() {
        const readingEpoch = epoch
        if (closed || !connected || !current()) return { ready: false, turns: [] }
        const life = phone ? null : await remote.machineRpc(deviceId).sessions.lifeView(sessionId)
        if (!phone && (!life || life.kind !== 'ready' || life.hold !== null)) return { ready: false, turns: [] }
        const snapshot = await client.fetchSnapshot(deviceId, sessionId, 100)
        const summary = liveDeviceSessions()[deviceId]?.sessions.find(session => session.conversationId === sessionId)
        if (!phone && !summary) return { ready: false, turns: [] }
        const native = !phone && summary?.runtime === 'acp'
          ? await remote.machineRpc(deviceId).sessionTimeline.sessionNativeRecord({ conversationId: sessionId, tail: true, limit: 100 }) : null
        if (native && !native.ok) throw Object.assign(new Error(native.error.message), { code: native.error.code })
        if (closed || !current() || readingEpoch !== epoch) return { ready: false, turns: [] }
        queuedIds = queueIds(snapshot.queuedPrompts)
        replying = Boolean(snapshot.liveReply)
        if (!subscribed) {
          await client.subscribeSession(deviceId, sessionId, subscriptionId, snapshot.cursor)
          if (closed || !current()) {
            await client.unsubscribeSession(deviceId, subscriptionId)
            return { ready: false, turns: [] }
          }
          subscribed = true
        }
        // Provider JSONL can omit its end marker; only the native durable foreground owns ACP completion.
        const record = native?.ok ? native.value : null
        return { ready: readingEpoch === epoch && connected && !failedSettlements.size && !snapshot.liveReply && !snapshot.queuedPrompts?.length
          && !snapshot.settlements?.some(settlement => settlement.state === 'pending') && (!record || (!record.hasNewer && !record.activeTurn)),
        turns: record ? record.turns : snapshot.turns }
      },
      dispose() {
        closed = true; stopEvents(); stopErrors?.(); stopLink(); stopLife(); stopSettled()
        void client.unsubscribeSession(deviceId, subscriptionId).catch(report)
      },
    }
  }
  return startPhoneSendQueueObserver(accountId, {
    current, inputs: () => state().rows, retainDirectory: requestPhoneTaskDirectory, available, observe, report,
    subscribe: listener => {
      let signature = ''
      const stopInputs = subscribeSessionInputs(listener)
      const stopDirectory = subscribeDeviceSessions(() => {
        const next = JSON.stringify(state().rows.filter(input => input.accountId === accountId && input.sendQueue).map(input => {
          const device = deviceOf(input), directory = device ? liveDeviceSessions()[device.device_id] : null
          return [input.deviceId, input.sessionId, device?.is_online, device && isAgentHostDevice(device), directory?.cached,
            directory?.connected, directory?.sessions.find(session => session.conversationId === input.sessionId)?.status,
            directory?.sessions.find(session => session.conversationId === input.sessionId)?.runtime]
        }))
        if (next === signature) return
        signature = next; listener()
      })
      // Existing reachability events retry a failed lookup; no second polling loop is introduced.
      const stopDevices = subscribeCachedDevices(() => { if (retryPending) { retryPending = false; listener() } })
      const visible = () => { if (document.visibilityState === 'visible') listener() }
      window.addEventListener('online', listener)
      document.addEventListener('visibilitychange', visible)
      return () => { stopInputs(); stopDirectory(); stopDevices(); window.removeEventListener('online', listener); document.removeEventListener('visibilitychange', visible) }
    },
    release: (sessionId, turns, canRelease) => releaseQueuedSessionInput(sessionId, turns, undefined, false, canRelease),
  })
}
