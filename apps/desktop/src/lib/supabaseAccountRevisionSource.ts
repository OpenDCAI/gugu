import type {
  AccountRevisionSource,
} from './accountRevisionRuntime'
import { parseRevisionPage } from './accountRevisionRuntime'
import {
  subscribePrivateUserEventBus,
  unsubscribePrivateUserEventBus,
  type PrivateUserEventBusHandle,
} from './realtimeChannel'
import { parseWakeHead } from './chatProjection'
import { dataClient } from './supabase'

export function createSupabaseAccountRevisionSource(): AccountRevisionSource {
  return {
    async syncSince(cursor, limit, signal) {
      const { data, error } = await dataClient
        .schema('chat')
        .rpc('sync_since', { p_after_revision: cursor, p_limit: limit })
        .abortSignal(signal)
      if (error) throw error
      return parseRevisionPage(data)
    },
    subscribeWake(accountId, onWake, onSubscribed) {
      const handle: PrivateUserEventBusHandle = subscribePrivateUserEventBus(
        accountId,
        'im_revision_advanced',
        // 广播 payload 就是 `{revision: <head>}`(publish_user_revision)。从前这里把它扔了,
        // 于是每条通知都要花一次往返去重新发现 head;现在把它交给 runtime 判是否已被涵盖。
        (payload) => onWake(parseWakeHead(payload)),
        { onSubscribed },
      )
      // R2 广播之外的拉取时机归账号作用域(ChatProvider 的 watchRendererRevisionReconcile),这里只管广播。
      return () => unsubscribePrivateUserEventBus(handle)
    },
  }
}
