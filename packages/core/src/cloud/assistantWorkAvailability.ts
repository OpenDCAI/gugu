import type { AssistantWorkOutboxContext, AssistantWorkRpcClient } from './assistantWorkOutbox'

export const ASSISTANT_WORK_AVAILABILITY_NOTICE = '暂时无法核对任务结果的交付情况，我会继续尝试。'

/** A visible, idempotent service notice uses ordinary chat storage, never a second outbox. */
export function createAssistantWorkAvailabilityNotifier(deps: {
  context(): Promise<AssistantWorkOutboxContext | null>
  assistant(ctx: AssistantWorkOutboxContext, signal: AbortSignal): Promise<string | null>
  rpc(ctx: AssistantWorkOutboxContext, name: string, args: Record<string, unknown>, signal: AbortSignal): ReturnType<AssistantWorkRpcClient['rpc']>
  visible(ctx: AssistantWorkOutboxContext, post: {assistantId: string; chatId: string; messageId: string}, signal: AbortSignal): Promise<boolean>
}) {
  return async (ctx: AssistantWorkOutboxContext, _failure: {code: string}, signal: AbortSignal) => {
    const check = async () => {
      signal.throwIfAborted()
      const current = await deps.context()
      signal.throwIfAborted()
      if (current?.ownerId !== ctx.ownerId || current.runtimeInstanceId !== ctx.runtimeInstanceId) throw new Error('Task notice account changed')
    }
    const rpc = async (name: string, args: Record<string, unknown>) => {
      await check()
      const result = await deps.rpc(ctx, name, args, signal)
      await check()
      if (result.error) throw result.error
      return result.data
    }
    await check()
    const assistantId = await deps.assistant(ctx, signal)
    if (!assistantId) throw new Error('Task notice assistant is unavailable')
    const chatId = await rpc('open_dm', {p_target_user_id: assistantId})
    if (typeof chatId !== 'string' || !chatId) throw new Error('Task notice chat is unavailable')
    // One warning per account/assistant/queue protocol, including device races and restarts.
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['work-availability-v1', ctx.ownerId, assistantId])))
    const hex = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const messageId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
    await rpc('send_message_idempotent', {
      p_message_id: messageId, p_chat_id: chatId, p_sender_user_id: assistantId, p_to_user_ids: [ctx.ownerId],
      p_content: ASSISTANT_WORK_AVAILABILITY_NOTICE, p_content_type: 'text', p_reply_to_message_id: null,
      p_thread_root_id: null, p_is_thread_root: false, p_is_whisper: false,
    })
    await check()
    if (!await deps.visible(ctx, {assistantId, chatId, messageId}, signal)) throw new Error('Task notice was not committed as a visible message')
    await check()
  }
}
