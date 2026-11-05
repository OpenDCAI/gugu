import type { RefObject } from 'react'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'

/**
 * ⌘F in a conversation is the global search scoped to it (a removable in: chip), the same panel every other entry
 * opens; there is no second, in-page search over the loaded window. The visible chat also answers from the sidebar;
 * focused terminal/editor commands take precedence.
 */
export function useChatSearch(chatId: string | null, enabled: boolean, surface: RefObject<HTMLElement | null>) {
  useCommandProvider({
    scopeId: 'app',
    isActive: (element) => enabled && !!chatId && isChatSearchTarget(surface.current, chatId, element),
    getCommands: () => !chatId ? [] : [{ id: 'app.find', hideFromPalette: true, execute: () => searchInChat(chatId) }],
  })
}
