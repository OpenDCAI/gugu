/** @jsxImportSource solid-js */
import { Show, type JSX } from 'solid-js';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconCheck, IconCopy, IconEdit } from '@session-chat/components/primitives/icons';
import { createClipboard } from '@session-chat/components/primitives/use-clipboard';
import { formatClock } from '@gugu/session-shared/format';
import { useChatLocale, useChatTranslator } from '@session-chat/localization';
import { userMessageActionsHeight, type MessageVars } from './metrics';
import { userMessageActionButton, userMessageActions, userMessageExpand, userMessageTime } from './user-message.css';

export function UserMessageActions(props: {
  itemId: string;
  text: string;
  at?: number;
  generating: boolean;
  readOnly?: boolean;
  vars: Pick<MessageVars, 'footerH'>;
  collapse?: { bubbleKey: string; anchorId: string };
  reference?: () => JSX.Element;
}) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const locale = useChatLocale();
  const timestamp = () => {
    if (props.at === undefined || props.at <= 0) return null;
    const date = new Date(props.at);
    return Number.isFinite(date.getTime()) ? date : null;
  };

  return (
    <div data-user-message-actions={props.itemId} data-conversation-reference-footer={props.reference ? 'true' : undefined} class={userMessageActions}
      style={{ height: `${userMessageActionsHeight(props.vars)}px` }}>
      <Show when={props.collapse}>{target => <button type="button" class={userMessageExpand}
        title={translate('transcript.collapseFullText')} data-collapse-id={target().bubbleKey}
        data-collapse-anchor={target().anchorId}>{translate('transcript.collapseFullText')}</button>}</Show>
      <Show when={timestamp()}>
        {(date) => <time class={userMessageTime} dateTime={date().toISOString()} title={date().toLocaleString()}>
          {formatClock(date(), locale())}
        </time>}
      </Show>
      {props.reference?.()}
      {/* Virtual rows are reused: copy feedback belongs to this message ID. */}
      <Show when={props.itemId} keyed>
        {(itemId) => {
          const { copied, copy } = createClipboard((error) => commands().onCopyError?.(error));
          const copyLabel = () => copied() ? translate('transcript.copied') : translate('transcript.copy');
          return <>
            <button type="button" class={userMessageActionButton} data-slot="message-copy"
              aria-label={copyLabel()} title={copyLabel()}
              onClick={(event) => { event.stopPropagation(); copy(props.text); }}>
              <Show when={copied()} fallback={<IconCopy />}><IconCheck /></Show>
            </button>
            <Show when={!props.readOnly && !props.generating && commands().onEditMessage && commands().canRevertMessage?.(itemId)}>
              <button type="button" class={userMessageActionButton} data-slot="message-edit"
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
