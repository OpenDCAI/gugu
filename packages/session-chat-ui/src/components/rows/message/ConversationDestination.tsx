/** @jsxImportSource solid-js */
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { conversationDestination } from './conversation-message.css';

/** The host supplies its existing tooltip primitive; standalone transcripts retain the full accessible label. */
export function ConversationDestination(props: { text: string; width: number }) {
  const commands = useCommands();
  const [root, setRoot] = createSignal<HTMLSpanElement>();
  createEffect(() => {
    const element = root(), mount = commands().onTooltipMount, text = props.text;
    if (!element || !mount) return;
    const cleanup = mount({ root: element, text });
    if (cleanup) onCleanup(cleanup);
  });
  return <span ref={setRoot} data-slot="sent-to" class={conversationDestination}
    style={{ width: `${props.width}px` }} aria-label={props.text}>{commands().onTooltipMount ? null : props.text}</span>;
}
