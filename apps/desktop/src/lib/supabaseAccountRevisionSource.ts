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
import { watchRevisionReconcile, type RevisionReconcileSignals } from './accountRevisionReconcile'
import { platform } from '../platform'
import { rendererLogger } from './log'

const reconcileLog = rendererLogger('chat/account-revision-reconcile')

function rendererReconcileSignals(): RevisionReconcileSignals {
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    onVisible: (listener) => {
      const onChange = () => { if (document.visibilityState === 'visible') listener() }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    onOnline: (listener) => {
      window.addEventListener('online', listener)
      return () => window.removeEventListener('online', listener)
    },
    onForeground: (listener) => platform.subscribeAppForeground(listener, (error) => {
      reconcileLog.error({ error }, 'app foreground subscription failed')
    }),
  }
}

export function createSupabaseAccountRevisionSource(): AccountRevisionSource {
  // An offline local task rename has no cloud revision yet. When the backend answers again (a resubscribed
  // identity bus, or the first account read after failed ones), the host resumes its existing name synchronization.
  const resumeNameSync = () => platform.notifyOwnedAgentsChanged?.()
  let unreachable = false
  return {
    async syncSince(cursor, limit, signal) {
      let data: unknown
      try {
        const result = await dataClient
          .schema('chat')
          .rpc('sync_since', { p_after_revision: cursor, p_limit: limit })
          .abortSignal(signal)
        if (result.error) throw result.error
        data = result.data
      } catch (error) {
        unreachable = true
        throw error
      }
      if (unreachable) {
        unreachable = false
        resumeNameSync()
      }
      return parseRevisionPage(data)
    },
    subscribeWake(accountId, onWake, onSubscribed) {
      const handle: PrivateUserEventBusHandle = subscribePrivateUserEventBus(
        accountId,
        'im_revision_advanced',
        // 广播 payload 就是 `{revision: <head>}`(publish_user_revision)。从前这里把它扔了,
        // 于是每条通知都要花一次往返去重新发现 head;现在把它交给 runtime 判是否已被涵盖。
        (payload) => onWake(parseWakeHead(payload)),
        { onSubscribed: () => {
          onSubscribed()
          resumeNameSync()
        } },
      )
      // R2 广播之外的拉取时机(定时对账 + 前台/可见/联网/唤醒),head 未知 ⇒ 按游标增量拉一次。
      const stopReconcile = watchRevisionReconcile(() => onWake(null), rendererReconcileSignals())
      return () => {
        stopReconcile()
        unsubscribePrivateUserEventBus(handle)
      }
    },
  }
}
