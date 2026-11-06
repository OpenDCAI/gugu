import { chatDb } from './supabase'

export type PersonalConversationHiding = {
  chat_id: string
  hidden_at: string
  operation_id: string
  account_revision: string
}

/** Temporary personal list state. Never dispatch through group-management or Agent-lifecycle APIs. */
export async function hideListedConversation(chatId: string, operationId: string): Promise<PersonalConversationHiding> {
  const { data, error } = await chatDb.rpc('hide_my_conversation', { p_chat_id: chatId, p_operation_id: operationId })
  if (error) throw new Error(error.message)
  if (!data || data.chat_id !== chatId || data.operation_id !== operationId || typeof data.hidden_at !== 'string'
    || !Number.isFinite(Date.parse(data.hidden_at)) || typeof data.account_revision !== 'string'
    || !/^(0|[1-9]\d*)$/.test(data.account_revision)) throw new Error('Conversation hiding was not confirmed')
  return { chat_id: data.chat_id, hidden_at: data.hidden_at, operation_id: data.operation_id, account_revision: data.account_revision }
}
