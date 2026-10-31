/** @jsxImportSource solid-js */
import { Show, type JSX } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import type { MessageSenderTarget } from '@session-chat/lib/sender-target';
import { senderNameLink } from './conversation-message.css';

export function SenderName(props: { name: string; class?: string; style?: JSX.CSSProperties; target: MessageSenderTarget | null }) {
  const commands = useCommands();
  return <Show when={props.target && commands().onOpenSender} fallback={<span class={props.class} style={props.style} title={props.name}>{props.name}</span>}>
    <button type="button" class={`${props.class ?? ''} ${senderNameLink}`} data-slot="sender-name-link" style={props.style} title={props.name}
      onClick={event => { event.stopPropagation(); if (props.target) commands().onOpenSender?.(props.target); }}>{props.name}</button>
  </Show>;
}
