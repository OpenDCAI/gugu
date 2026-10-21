import { createGuguSupabaseClient } from '../../cloud/supabase'

/**
 * The identifiers of one delivered message that an agent has just received into its terminal.
 */
export interface AgentDeliveredMessageRead {
  chatId: string
  messageId: string
  agentUserId: string
}

/**
 * @@@delivered-read-eager — an agent has "read" a message the instant it is inserted into its terminal
 * (the deliver handler's `sendText` has resolved). Fires `mark_read_on_deliver` EAGERLY — no deferred
 * pending-file queue, no UserPromptSubmit/Stop hook flush. This is the SINGLE read chain, decoupled
 * from the working-status hook (#800).
 *
 * `mark_read_on_deliver` is gap-safe server-side: it advances the agent's `chat_members.last_read_seq`
 * to this message only if no earlier message from another member is still unread, so it never lies about
 * having read something the agent skipped.
 *
 * A transient RPC failure throws to the caller, which records the accepted delivery as unsettled while
 * preserving chat order. The caller supplies the same live owner token that pulled the row; reading a
 * second token from the runtime-session sidecar here would let a stale snapshot strand the cursor.
 */
export async function markAgentDeliveredMessageRead(
  input: AgentDeliveredMessageRead,
  options: {
    /** The live owner token used by the pull that admitted this message. */
    accessToken: string
    /** Injectable so the eager mark is unit-testable without a live RPC. */
    markRead?: (input: AgentDeliveredMessageRead) => Promise<void> | void
  }
): Promise<void> {
  const markRead = options.markRead ?? defaultMarkRead(options.accessToken)
  await markRead(input)
}

function defaultMarkRead(
  accessToken: string,
): (input: AgentDeliveredMessageRead) => Promise<void> {
  const client = createGuguSupabaseClient({
    schema: 'identity',
    headers: { Authorization: `Bearer ${accessToken}` }
  }) as unknown as {
    rpc(
      fn: 'mark_read_on_deliver',
      args: Record<string, unknown>
    ): PromiseLike<{ error: { message: string } | null }>
  }
  return async (input) => {
    const { error } = await client.rpc('mark_read_on_deliver', {
      p_chat_id: input.chatId,
      p_message_id: input.messageId,
      p_user_id: input.agentUserId
    })
    if (error) throw new Error(error.message)
  }
}
