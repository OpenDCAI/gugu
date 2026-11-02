import type { SubscribeOwnedAgentChanges } from '@gugu/core'
import { isSubscribeFailure, subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol'
import { subscribeAuthenticatedElectronRealtimeChannel, type ElectronManagedRealtimeChannel } from './realtime-channel'

type OwnedAgentChannel = ElectronManagedRealtimeChannel & {
  on: (kind: 'broadcast', filter: { event: string }, callback: () => void) => unknown
}

export function createDesktopOwnedAgentChangesSubscription<TChannel>({ supabase, warn = console.warn }: {
  supabase: {
    realtime: { setAuth: () => unknown | Promise<unknown> }
    channel: (topic: string, options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }) => TChannel
    removeChannel: (channel: TChannel) => unknown
  }
  warn?: (message: string) => void
}): SubscribeOwnedAgentChanges {
  return async ({ ownerUserId, onChanged }) => {
    let active = true
    const changed = () => {
      if (active) void onChanged().catch(error => warn(`[device-runtime] owned agents refresh failed: ${String(error)}`))
    }
    const createChannel = () => {
      const channel = supabase.channel(`gugu:user:${ownerUserId}:agents`, {
        config: { private: true, broadcast: { self: false, ack: true } },
      }) as TChannel & OwnedAgentChannel
      channel.on('broadcast', { event: 'agent_changed' }, changed)
      return channel
    }
    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel({
      realtime: supabase.realtime,
      removeChannel: channel => supabase.removeChannel(channel as TChannel),
    }, createChannel(), {
      label: `owned-agents:${ownerUserId}`,
      createChannel,
      onStatus: (status, error) => {
        if (!active) return
        const name = subscribeStatusName(status)
        // Broadcasts have no backlog: every successful subscription reconciles changes missed offline.
        if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) changed()
        else if (isSubscribeFailure(status)) warn(`[device-runtime] owned agents subscribe failed: ${name}${error ? ` ${error.message}` : ''}`)
      },
      reconnectOnStatus: isSubscribeFailure,
    })
    return () => { active = false; unsubscribe() }
  }
}
