/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useChatTranslator } from '@session-chat/localization';
import { conversationQuote, conversationQuotePreview, conversationReference } from './conversation-message.css';

export function ConversationReplyReference(props: { itemId: string; text: string }) {
  const commands = useCommands(), translate = useChatTranslator();
  const [root, setRoot] = createSignal<HTMLSpanElement>();
  const [open, setOpen] = createSignal(false), [touch, setTouch] = createSignal(false);
  const label = () => translate('transcript.showOriginalMessage');
  const navigate = () => commands().onConversationReply?.(props.itemId);
  createEffect(() => {
    const element = root(), mount = commands().onTooltipMount, itemId = props.itemId, text = props.text;
    if (!element || !mount) return;
    const cleanup = mount({ root: element, text, originalLabel: label(), onOpenOriginal: () => commands().onConversationReply?.(itemId) });
    if (cleanup) onCleanup(cleanup);
  });
  return <span ref={setRoot} class={conversationReference} data-slot="conversation-reference"
    onPointerLeave={() => { if (!touch()) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <Show when={!commands().onTooltipMount}>
      <button type="button" class={conversationQuote} data-slot="conversation-quote" aria-label={label()}
        disabled={!commands().onConversationReply} aria-expanded={open()}
        onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true); }}
        onPointerDown={event => setTouch(event.pointerType === 'touch')}
        onFocus={() => { if (!touch()) setOpen(true); }} onClick={event => { event.stopPropagation(); if (touch()) setOpen(!open()); else navigate(); }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.5 3v4.5a3 3 0 0 1-3 3H3m3.5-3.5L3 10.5 6.5 14" /></svg>
      </button>
      <Show when={open()}><Portal><div class={conversationQuotePreview} data-slot="conversation-quote-preview" role="dialog" aria-label={label()}
        style={{ position: 'fixed', top: `${root()?.getBoundingClientRect().bottom ?? 0}px`, left: `${Math.min(root()?.getBoundingClientRect().left ?? 0, Math.max(0, window.innerWidth - 336))}px` }}>
        <button type="button" onClick={navigate}>{props.text}</button>
      </div></Portal></Show>
    </Show>
  </span>;
}
