/** @jsxImportSource solid-js */
import { copyFailureText } from '@session-chat/components/primitives/copy-button.css';
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
  vars: MessageVars;
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
      <Show when={timestamp()}>
        {(date) => <time class={userMessageTime} dateTime={date().toISOString()} title={date().toLocaleString()}>
          {`${date().getHours()}:${String(date().getMinutes()).padStart(2, '0')}`}
        </time>}
      </Show>
      {/* Virtual rows are reused: copy feedback belongs to this message ID. */}
      <Show when={props.itemId} keyed>
        {(itemId) => {
          const { copied, failed, copy } = createClipboard(translate);
          const copyLabel = () => failed() ?? (copied() ? translate('transcript.copied') : translate('transcript.copyMessage'));
          return <>
            <button type="button" class={userMessageActionButton}
              aria-label={copyLabel()} title={copyLabel()}
              onClick={(event) => { event.stopPropagation(); copy(props.text); }}>
              <Show when={failed()}><span class={copyFailureText} role="alert">{failed()}</span></Show>
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
