/** @jsxImportSource solid-js */
import { Show } from 'solid-js';
import type { ChatMessage } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { vars } from '@session-chat/styles/theme.css';

export const INPUT_SEND_FAILURE_HEIGHT = 22;
export const inputSendStatusHeight = (item: ChatMessage): number => item.sendStatus?.state === 'failed' || item.sendStatus?.state === 'unknown' ? INPUT_SEND_FAILURE_HEIGHT : 0;

/** Sending is an overlay beside the unchanged bubble; failure adds one measured action line. */
export function InputSendStatus(props: { item: ChatMessage; right: number; top: number }) {
  const t = useChatTranslator();
  const commands = useCommands();
  return <>
    <Show when={props.item.sendStatus?.state === 'sending'}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" class="gg-ring-march" role="img"
        aria-label={t('transcript.sending')} data-send-state="sending"
        style={{ position: 'absolute', right: `${props.right}px`, top: `${props.top}px`, opacity: .56, color: vars.fgMuted }}>
        <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 3.2" stroke-linecap="round" />
      </svg>
    </Show>
    <Show when={props.item.sendStatus?.state === 'failed' || props.item.sendStatus?.state === 'unknown'}>
      <div data-send-state={props.item.sendStatus?.state} role="alert" title={props.item.sendStatus?.error}
        style={{ height: `${INPUT_SEND_FAILURE_HEIGHT}px`, display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', gap: '8px', 'font-size': '12px', color: vars.fgError }}>
        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{t(props.item.sendStatus?.state === 'unknown' ? 'transcript.sendUnknown' : 'transcript.sendFailed')}</span>
        <Show when={commands().onRetrySend && props.item.sendStatus?.retryable !== false}>
          <button type="button" onClick={() => commands().onRetrySend?.(props.item.id)}
            style={{ color: 'inherit', cursor: 'pointer', 'flex-shrink': 0 }}>{t('transcript.retrySend')}</button>
        </Show>
      </div>
    </Show>
  </>;
}
