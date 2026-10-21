import { useEffect, useState } from 'react'
import {
  MESSAGE_PREVIEW_EVENT,
  messagePreviewTopic,
  type MessagePreviewPayload,
} from '@gugu/session-core/session-record/message-preview'
import { SUBSCRIPTION_KEEPALIVE_MS } from '@gugu/session-core/session-record/contract'
import { dataClient } from '../lib/supabase'
import {
  subscribeAuthenticatedRealtimeChannel,
  unsubscribeAuthenticatedRealtimeChannel,
} from '../lib/realtimeChannel'

/**
 * MessagePreview(#6357)订阅端:卡片开着才订,节拍同手机会话页(25s 保活、宿主 90s 拆)。
 * 先加入 topic 再经 `chat.message_preview_*` 请宿主开推,否则第一份会落在加入之前。
 */
export type AgentMessagePreviewState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'live'; preview: MessagePreviewPayload }
  | { status: 'unavailable'; error: string }

/** 中转是广播,宿主不在线库那步也成功;等不到第一份就如实报「拿不到」。 */
export const FIRST_PAYLOAD_TIMEOUT_MS = 10_000

function newSubscriptionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isPayloadFor(value: unknown, chatId: string, agentId: string): value is MessagePreviewPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<MessagePreviewPayload>
  return (
    payload.chatId === chatId &&
    payload.agentId === agentId &&
    typeof payload.rev === 'number' &&
    typeof payload.epoch === 'string' &&
    Array.isArray(payload.entries)
  )
}

type Op = 'subscribe' | 'keepalive' | 'unsubscribe'

async function relay(op: Op, chatId: string, agentId: string, subscriptionId: string): Promise<string | null> {
  const { error } = await dataClient.schema('chat').rpc(`message_preview_${op}`, {
    p_chat_id: chatId,
    p_agent_id: agentId,
    p_subscription_id: subscriptionId,
  })
  return error ? error.message : null
}

export function useAgentMessagePreview(
  chatId: string | null,
  agentId: string | null,
  enabled: boolean,
): AgentMessagePreviewState {
  // subject-scoped(#3922):主体一换,渲染期就交出 connecting,不让上一个 agent 的近况串过来。
  const subject = enabled && chatId && agentId ? `${chatId}:${agentId}` : null
  const [stored, setStored] = useState<{ subject: string | null; state: AgentMessagePreviewState }>({
    subject: null,
    state: { status: 'idle' },
  })

  useEffect(() => {
    if (!subject || !chatId || !agentId) return
    const setState = (
      next: AgentMessagePreviewState | ((current: AgentMessagePreviewState) => AgentMessagePreviewState),
    ) =>
      setStored((current) => {
        const base = current.subject === subject ? current.state : ({ status: 'connecting' } as const)
        return { subject, state: typeof next === 'function' ? next(base) : next }
      })
    let active = true
    const subscriptionId = newSubscriptionId()
    let latest: MessagePreviewPayload | null = null
    let keepalive: ReturnType<typeof setInterval> | null = null
    let requested = false
    setState({ status: 'connecting' })
    const firstPayloadTimer = setTimeout(() => {
      if (!latest) fail('host_unreachable')
    }, FIRST_PAYLOAD_TIMEOUT_MS)

    const accept = (payload: MessagePreviewPayload) => {
      // 同一 epoch 只收更新的 rev;宿主重启换 epoch 后直接收。
      if (latest && latest.epoch === payload.epoch && payload.rev <= latest.rev) return
      latest = payload
      if (active) setState({ status: 'live', preview: payload })
    }

    const fail = (error: string) => {
      if (!active) return
      setState((current) => (current.status === 'live' ? current : { status: 'unavailable', error }))
    }

    // 请求串行:退订必须排在订阅之后,否则宿主会留一张没人续的租约。
    let chain: Promise<void> = Promise.resolve()
    const request = (op: Op) => {
      chain = chain.then(() =>
        relay(op, chatId, agentId, subscriptionId).then((error) => {
          if (error && op !== 'unsubscribe') fail(error)
        }),
      )
      return chain
    }

    const channel = subscribeAuthenticatedRealtimeChannel(
      () =>
        dataClient
          .channel(messagePreviewTopic(chatId, agentId), {
            config: { private: true, broadcast: { self: false, ack: false } },
          })
          .on('broadcast', { event: MESSAGE_PREVIEW_EVENT }, (message: { payload?: unknown }) => {
            if (isPayloadFor(message.payload, chatId, agentId)) accept(message.payload)
          }),
      `message-preview:${chatId}:${agentId}`,
      {
        shouldSubscribe: () => active,
        reconnectWhenIdle: false,
        onSubscribed: () => {
          if (!active) return
          // 重连后再请求一次(幂等):断线期间宿主可能已经拆了这份。
          void request(requested ? 'keepalive' : 'subscribe')
          requested = true
          if (!keepalive) keepalive = setInterval(() => void request('keepalive'), SUBSCRIPTION_KEEPALIVE_MS)
        },
      },
    )

    return () => {
      active = false
      clearTimeout(firstPayloadTimer)
      if (keepalive) clearInterval(keepalive)
      unsubscribeAuthenticatedRealtimeChannel(channel)
      if (requested) void request('unsubscribe')
    }
  }, [subject, chatId, agentId])

  if (!subject) return { status: 'idle' }
  return stored.subject === subject ? stored.state : { status: 'connecting' }
}
