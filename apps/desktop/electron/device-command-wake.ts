import type { SubscribeDeviceCommandWake } from '@gugu/core'
import type { ElectronManagedRealtimeChannel } from './realtime-channel'
import { subscribeAuthenticatedElectronRealtimeChannel } from './realtime-channel'
import { isSubscribeFailure, subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol'

type WakeChannel = {
  on: (kind: 'broadcast', filter: { event: string }, callback: (message?: { payload?: { id?: unknown } }) => void) => WakeChannel
  subscribe: (callback: (status: string, err?: Error) => void) => WakeChannel
}

type WakeSupabaseClient<TChannel> = {
  realtime: {
    setAuth: (accessToken: string) => unknown | Promise<unknown>
  }
  channel: (
    topic: string,
    options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }
  ) => TChannel
  removeChannel: (channel: TChannel) => unknown
}

export function createDesktopDeviceCommandWakeSubscription<TChannel>({
  supabase,
  warn = console.warn
}: {
  supabase: WakeSupabaseClient<TChannel>
  warn?: (message: string) => void
}): SubscribeDeviceCommandWake {
  return async ({ deviceId, accessToken, onCommand, onSubscribed, onSubscriptionLost, onSubscribeFailure }) => {
    let active = true
    let subscribedOnce = false
    const createWakeChannel = () => {
      const channel = supabase.channel(`gugu:${deviceId}:commands`, {
        config: {
          private: true,
          broadcast: { self: false, ack: true }
        }
      })
      const wakeChannel = channel as TChannel & WakeChannel & ElectronManagedRealtimeChannel
      wakeChannel.on('broadcast', { event: 'command_created' }, (message) => {
        if (!active) return
        // 广播负载点名了是哪一行(触发器写的 `id`);宿主据此分辨「这一行被通知过」与「别的行被通知过」。
        const commandId = typeof message?.payload?.id === 'string' ? message.payload.id : undefined
        void onCommand(commandId).catch((err) => {
          warn(`[device-runtime] ${(err as Error).message}`)
        })
      })
      return wakeChannel
    }
    const wakeChannel = createWakeChannel()
    const realtimeClient = {
      realtime: supabase.realtime,
      removeChannel: (channel: ElectronManagedRealtimeChannel) => {
        return supabase.removeChannel(channel as TChannel)
      }
    }
    const unsubscribe = await subscribeAuthenticatedElectronRealtimeChannel(realtimeClient, wakeChannel, {
      accessToken,
      label: `device-command-wake:${deviceId}`,
      createChannel: createWakeChannel,
      onStatus: (status, err) => {
        const name = subscribeStatusName(status)
        if (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED')) {
          subscribedOnce = true
          if (active) {
            onSubscribed?.()
            // @@@subscribe-catchup — 每一次(重新)订阅成功都补拉一轮。广播是 at-most-once、断线期间没有队列,而 pending
            // 队列本身是持久的 —— 订上的那一刻取一次,错过的就全回来了(#5906)。没有它,断线期间入队的行要等到下一个
            // 对账节拍(30 s)才被取走,而且会被记成「没被事件通知过」。❌ 别把它当成可有可无的优化删掉。
            void onCommand().catch((commandErr) => {
              warn(`[device-runtime] ${(commandErr as Error).message}`)
            })
          }
          return
        }
        if (!isSubscribeFailure(status)) return
        if (!active) return
        warn(
          `[device-runtime] command wake subscribe failed: ${name}${err ? ` ${(err as Error).message}` : ''}`
        )
        if (subscribedOnce) {
          // 订上过的频道掉了:重连由 managed channel 自己退避着做,宿主只需要知道「此刻没订着」。
          onSubscriptionLost?.()
          return
        }
        active = false
        onSubscribeFailure()
      },
      reconnectOnStatus: (status) => isSubscribeFailure(status),
      unsubscribeOnStatus: (status) => {
        const name = subscribeStatusName(status)
        return isSubscribeFailure(status) && !subscribedOnce && !name.endsWith('.SUBSCRIBED')
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }
}
