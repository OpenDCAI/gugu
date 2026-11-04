import { createContext, useContext } from 'react'
import { NO_CLASH_NAMES } from '../../lib/chatClashNames'

export const ChatClashNames = createContext<{ chatId: string | null; names: ReadonlyMap<string, string> }>({ chatId: null, names: NO_CLASH_NAMES })
export const useChatClashNames = () => useContext(ChatClashNames)
