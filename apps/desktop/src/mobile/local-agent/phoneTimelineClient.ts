import type { ToolImage } from '@gugu/session-core/acp/client'
import type { RecordCursor, SessionpageSessionRespondRequest, SessionpageSessionRespondResult, TimelineAfterResult, TimelineOlderResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import type { SessionpageTimelineClient } from '../agent-watch/use-timeline-session'
import { invokePhoneHost } from './phoneHostRpc'
import { sendPhoneTaskText } from './phoneTaskSend'
import { reconnectDelayMs } from '@/session/shared/remote-reconnect'

type Poll = { deviceId: string; sessionId: string; cursor: RecordCursor | null; timer?: ReturnType<typeof setTimeout>; running: boolean; failures: number }
const POLL_MS = 800

/** Phone timelines use the shared reducer and cursor contract over the existing native/RPC calls. */
export function createPhoneTimelineClient(invoke = invokePhoneHost): SessionpageTimelineClient {
  const polls = new Map<string, Poll>()
  const events = new Map<string, (result: TimelineAfterResult) => void>()
  const errors = new Map<string, (error: unknown) => void>()
  const links = new Map<string, Set<(open: boolean) => void>>()
  const connected = new Map<string, boolean>()
  const markLink = (deviceId: string, open: boolean) => {
    const previous = connected.get(deviceId) ?? true
    connected.set(deviceId, open)
    if (previous !== open) for (const cb of links.get(deviceId) ?? []) cb(open)
  }
  const stop = (id: string) => {
    const poll = polls.get(id)
    if (poll?.timer) clearTimeout(poll.timer)
    polls.delete(id)
  }
  const tick = async (id: string, poll: Poll): Promise<void> => {
    if (polls.get(id) !== poll || poll.running || !poll.cursor) return
    poll.running = true
    if (poll.timer) clearTimeout(poll.timer)
    try {
      const result = await invoke<TimelineAfterResult>(poll.deviceId, 'sessionTimeline.sessionAfter', [{ conversationId: poll.sessionId, cursor: poll.cursor, trim: true }])
      if (polls.get(id) !== poll) return
      poll.cursor = result.ok ? result.batch.cursor : result.snapshot.cursor
      poll.failures = 0
      events.get(id)?.(result)
      markLink(poll.deviceId, true)
    } catch (error) {
      if (polls.get(id) === poll) {
        poll.failures += 1
        errors.get(id)?.(error)
        markLink(poll.deviceId, false)
      }
    } finally {
      poll.running = false
      if (polls.get(id) === poll) poll.timer = setTimeout(() => { void tick(id, poll) }, poll.failures ? reconnectDelayMs(poll.failures) : POLL_MS)
    }
  }
  const client: SessionpageTimelineClient = {
    fetchSnapshot: (deviceId, sessionId, limit) => invoke<TimelineSnapshot>(deviceId, 'sessionTimeline.sessionSnapshot', [{ conversationId: sessionId, ...(limit === undefined ? {} : { limit }), trim: true }]),
    fetchAfter: (deviceId, sessionId, cursor) => invoke<TimelineAfterResult>(deviceId, 'sessionTimeline.sessionAfter', [{ conversationId: sessionId, cursor, trim: true }]),
    fetchOlder: (deviceId, sessionId, beforeTurnId, limit) => invoke<TimelineOlderResult>(deviceId, 'sessionTimeline.sessionOlder', [{ conversationId: sessionId, beforeTurnId, ...(limit === undefined ? {} : { limit }), trim: true }]),
    fetchToolImage: (deviceId, sessionId, itemId, index) => invoke<ToolImage>(deviceId, 'sessionTimeline.sessionToolImage', [{ conversationId: sessionId, itemId, index }]),
    subscribeSession: async (deviceId, sessionId, subscriptionId, cursor) => {
      stop(subscriptionId)
      const poll: Poll = { deviceId, sessionId, cursor, running: false, failures: 0 }
      polls.set(subscriptionId, poll)
      try { poll.cursor ??= (await client.fetchSnapshot(deviceId, sessionId)).cursor }
      catch (error) { if (polls.get(subscriptionId) === poll) stop(subscriptionId); throw error }
      if (polls.get(subscriptionId) !== poll) return
      void tick(subscriptionId, poll)
    },
    unsubscribeSession: async (_deviceId, subscriptionId) => { stop(subscriptionId) },
    subscribeSessionEvents: (_deviceId, subscriptionId, cb) => {
      events.set(subscriptionId, cb)
      return () => { events.delete(subscriptionId); stop(subscriptionId) }
    },
    subscribeSessionErrors: (_deviceId, subscriptionId, cb) => {
      errors.set(subscriptionId, cb)
      return () => { errors.delete(subscriptionId) }
    },
    onLinkChange: (deviceId, cb) => {
      const listeners = links.get(deviceId) ?? new Set()
      listeners.add(cb)
      links.set(deviceId, listeners)
      const wake = () => {
        if (document.visibilityState !== 'visible') return
        for (const [id, poll] of polls) if (poll.deviceId === deviceId) void tick(id, poll)
      }
      window.addEventListener('online', wake)
      document.addEventListener('visibilitychange', wake)
      return () => {
        listeners.delete(cb)
        if (!listeners.size) { links.delete(deviceId); connected.delete(deviceId) }
        window.removeEventListener('online', wake)
        document.removeEventListener('visibilitychange', wake)
      }
    },
    sendSessionText: (deviceId, sessionId, text) => sendPhoneTaskText(deviceId, sessionId, text, invoke),
    cancelSessionTurn: (deviceId, sessionId) => invoke<{ cancelled: boolean }>(deviceId, 'sessionTimeline.sessionCancel', [{ conversationId: sessionId }]),
    respondToSettlement: (deviceId, input: SessionpageSessionRespondRequest) => invoke<SessionpageSessionRespondResult>(deviceId, 'sessionTimeline.sessionRespond', [input]),
  }
  return client
}

export const phoneTimelineClient = createPhoneTimelineClient()
