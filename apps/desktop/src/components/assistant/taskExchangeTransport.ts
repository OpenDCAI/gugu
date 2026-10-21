import type { TaskExchangeTransport } from '../../lib/taskExchangeReader'
import { taskExchangeChannel } from '../../session/shared/core/session-timeline/sessionTimelineEvents'

export async function taskExchangeTransport(deviceId: string, local: boolean): Promise<TaskExchangeTransport> {
  if (local) {
    const { rpcOn, events } = await import('../../session/renderer/lib/ipc')
    const api = rpcOn(null).sessionTimeline
    return {
      read: (request) => api.taskExchanges(request),
      subscribe: (request) => api.taskExchangesSubscribe(request),
      unsubscribe: (subscriptionId) => api.taskExchangesUnsubscribe({ subscriptionId }),
      onPage: (id, receive) => events.on(taskExchangeChannel, receive, id),
    }
  }
  const { machineRpc, onMachineEvent, onLinkChange } = await import('../../mobile/agent-watch/sessionpage-rpc')
  const api = machineRpc(deviceId).sessionTimeline
  return {
    read: (request) => api.taskExchanges(request),
    subscribe: (request) => api.taskExchangesSubscribe(request),
    unsubscribe: (subscriptionId) => api.taskExchangesUnsubscribe({ subscriptionId }),
    onPage: (id, receive) => onMachineEvent(deviceId, { name: `${taskExchangeChannel.name}.${id}` }, receive),
    onLink: (changed) => onLinkChange(deviceId, changed),
  }
}
