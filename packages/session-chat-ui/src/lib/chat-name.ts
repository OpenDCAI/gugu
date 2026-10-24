/**
 * A group's name as the person reads it, by its chat id — for a delivery that came from a group ("via group X"). The
 * envelope carries the group's number (agents address it); the host names it from its chats. `null` = the host does
 * not know that chat: the card says "via a group" without a name, ❌ never the number.
 */
import { createContext, useContext } from 'solid-js';

const ChatNameContext = createContext<(chatId: string) => string | null>(() => null);

export const ChatNameProvider = ChatNameContext.Provider;

/** Reactive accessor; returns `null` when the host declared no resolver. */
export function useChatName(): (chatId: string) => string | null {
  return useContext(ChatNameContext);
}
