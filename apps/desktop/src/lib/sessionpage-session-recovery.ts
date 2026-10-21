import { desktopIpc } from '../platform/desktopIpc'
/** Gate agent-chat sends before they can be rendered as delivered. */
export async function ensureSessionpageSessionReadyForChat(
  isAgentChat: boolean,
  agentUserId: string | null | undefined,
  fallbackError: string,
): Promise<void> {
  if (!isAgentChat || !agentUserId) return
  const api = desktopIpc()
  if (!api) return
  const raw = await api.invoke('sessionpage:ensure-session-ready', agentUserId)
  if (raw && typeof raw === 'object' && (raw as { status?: unknown }).status === 'failed') {
    throw new Error(String((raw as { error?: unknown }).error ?? fallbackError))
  }
}

export function createSessionpageChatSendPreflight(
  isAgentChat: boolean,
  agentUserId: string | null | undefined,
  fallbackError: string,
): () => Promise<void> {
  return () => ensureSessionpageSessionReadyForChat(isAgentChat, agentUserId, fallbackError)
}
