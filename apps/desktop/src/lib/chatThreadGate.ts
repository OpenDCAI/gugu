import { chatDb } from './supabase'

type ChatKind = 'dm' | 'ai' | 'group'

export async function getChatKind(chatId: string, operation: string): Promise<ChatKind> {
  const { data, error } = await chatDb
    .from('chats')
    .select('kind')
    .eq('id', chatId)
    .maybeSingle()
  if (error) throw new Error(error.message)

  const kind = (data as { kind?: unknown } | null)?.kind
  if (kind === 'dm' || kind === 'ai' || kind === 'group') return kind
  throw new Error(`${operation}: unknown chat kind for ${chatId}`)
}

export async function requireThreadCapableChat(chatId: string, operation: string): Promise<void> {
  if ((await getChatKind(chatId, operation)) !== 'group') {
    throw new Error(`${operation}: private chats do not support threads`)
  }
}
