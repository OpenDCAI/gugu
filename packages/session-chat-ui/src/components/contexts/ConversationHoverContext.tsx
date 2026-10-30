/** @jsxImportSource solid-js */
import { createContext, createSignal, useContext, type Accessor, type JSX } from 'solid-js';

import type { ChatCommands } from '@session-chat/commands';
import { CommandsContext } from './CommandsContext';

/** One presentation signal per transcript, shared by a reply's virtual head and body rows. */
export const ConversationHoverContext = createContext<{ current: Accessor<string | null>; set: (id: string | null) => void }>();
export const useConversationHover = () => useContext(ConversationHoverContext);

export function ConversationCommandsProvider(props: { value: Accessor<ChatCommands>; children: JSX.Element }) {
  const [current, set] = createSignal<string | null>(null);
  return <CommandsContext.Provider value={props.value}><ConversationHoverContext.Provider value={{ current, set }}>
    {props.children}
  </ConversationHoverContext.Provider></CommandsContext.Provider>;
}
