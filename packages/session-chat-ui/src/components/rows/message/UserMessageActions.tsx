/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconCheck, IconCopy, IconEdit } from '@session-chat/components/primitives/icons';
import { createClipboard } from '@session-chat/components/primitives/use-clipboard';
import { useChatTranslator } from '@session-chat/localization';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { userMessageActionButton, userMessageActions, userMessageTime } from './user-message.css';

export function UserMessageActions(props: {
  itemId: string;
  text: string;
  at?: number;
  generating: boolean;
  readOnly?: boolean;
  vars: Pick<MessageVars, 'footerH'>;
  onQuote?: () => void;
}) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const timestamp = () => {
    if (props.at === undefined || props.at <= 0) return null;
    const date = new Date(props.at);
    return Number.isFinite(date.getTime()) ? date : null;
  };

  return (
    <div data-user-message-actions={props.itemId} class={userMessageActions}
      style={{ height: `${userMessageActionsHeight(props.vars)}px` }}>
      <Show when={props.onQuote}>
        <button type="button" class={userMessageActionButton} aria-label={translate('transcript.quoteMessage')}
          onClick={event => { event.stopPropagation(); props.onQuote?.(); }}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12.5 3v4.5a3 3 0 0 1-3 3H3m3.5-3.5L3 10.5 6.5 14" /></svg>
        </button>
      </Show>
      <Show when={timestamp()}>
        {(date) => <time class={userMessageTime} dateTime={date().toISOString()} title={date().toLocaleString()}>
          {`${date().getHours()}:${String(date().getMinutes()).padStart(2, '0')}`}
        </time>}
      </Show>
      {/* Virtual rows are reused: copy feedback belongs to this message ID. */}
      <Show when={props.itemId} keyed>
        {(itemId) => {
          const { copied, copy } = createClipboard((error) => commands().onCopyError?.(error));
          const copyLabel = () => copied() ? translate('transcript.copied') : translate('transcript.copy');
          return <>
            <button type="button" class={userMessageActionButton}
              aria-label={copyLabel()} title={copyLabel()}
              onClick={(event) => { event.stopPropagation(); copy(props.text); }}>
              <Show when={copied()} fallback={<IconCopy />}><IconCheck /></Show>
            </button>
            <Show when={!props.readOnly && !props.generating && commands().onEditMessage && commands().canRevertMessage?.(itemId)}>
              <button type="button" class={userMessageActionButton}
                aria-label={translate('transcript.editMessage')} title={translate('transcript.editMessage')}
                onClick={(event) => { event.stopPropagation(); commands().onEditMessage?.({ itemId }); }}>
                <IconEdit />
              </button>
            </Show>
          </>;
        }}
      </Show>
    </div>
  );
}
