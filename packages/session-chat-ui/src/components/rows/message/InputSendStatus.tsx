/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { ChatMessage } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { vars } from '@session-chat/styles/theme.css';

export const INPUT_SEND_FAILURE_HEIGHT = 22;
export const inputSendStatusHeight = (item: ChatMessage): number => item.sendStatus?.state === 'waiting' || item.sendStatus?.state === 'failed' || item.sendStatus?.state === 'unknown' ? INPUT_SEND_FAILURE_HEIGHT : 0;

/** Sending is an overlay beside the unchanged bubble; waiting or failure adds one measured status line. */
export function InputSendStatus(props: { item: ChatMessage; right: number; top: number }) {
  const t = useChatTranslator();
  const commands = useCommands();
  const [failureRoot, setFailureRoot] = createSignal<HTMLElement>();
  const manual = () => props.item.sendStatus?.state === 'failed' && !!commands().canDiscardSend?.(props.item.id) && !!commands().onInputSendFailureMount;
  createEffect(() => {
    const root = failureRoot(), mount = commands().onInputSendFailureMount;
    if (!root || !mount || !manual()) return;
    const cleanup = mount({ root, itemId: props.item.id, error: props.item.sendStatus?.error, reason: props.item.sendStatus?.reason });
    if (cleanup) onCleanup(cleanup);
  });
  return <>
    <Show when={props.item.sendStatus?.state === 'sending'}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" class="gg-ring-march" role="img"
        aria-label={t('transcript.sending')} data-send-state="sending"
        style={{ position: 'absolute', right: `${props.right}px`, top: `${props.top}px`, opacity: .56, color: vars.fgMuted }}>
        <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 3.2" stroke-linecap="round" />
      </svg>
    </Show>
    <Show when={props.item.sendStatus?.state === 'receiving'}>
      <svg width="15" height="15" viewBox="0 0 15 15" role="img" aria-label={t('transcript.waitingToReceive')}
        data-send-state="receiving" style={{ position: 'absolute', right: `${props.right}px`, top: `${props.top}px`, opacity: .56, color: vars.fgMuted }}>
        {[3, 7.5, 12].map((x, index) => <circle cx={x} cy="7.5" r="1.3" fill="currentColor" class="gg-receive-dot" style={{ 'animation-delay': `${index * 140}ms` }} />)}
      </svg>
    </Show>
    <Show when={props.item.sendStatus?.state === 'waiting'}>
      <div data-send-state="waiting" role="status" title={props.item.sendStatus?.error}
        style={{ height: `${INPUT_SEND_FAILURE_HEIGHT}px`, display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', 'font-size': '12px', color: vars.fgMuted }}>
        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{t('transcript.waitingToSend')}{props.item.sendStatus?.reason ? ` · ${props.item.sendStatus?.reason}` : ''}</span>
      </div>
    </Show>
    <Show when={props.item.sendStatus?.state === 'failed' || props.item.sendStatus?.state === 'unknown'}>
      <div data-send-state={props.item.sendStatus?.state} role="alert" title={props.item.sendStatus?.error}
        style={{ height: `${INPUT_SEND_FAILURE_HEIGHT}px`, display: 'flex', 'align-items': 'center', 'justify-content': 'flex-end', gap: '8px', 'font-size': '12px', color: vars.fgError }}>
        <Show when={manual()} fallback={<span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{t(props.item.sendStatus?.state === 'unknown' ? 'transcript.sendUnknown' : 'transcript.sendFailed')}{props.item.sendStatus?.reason ? ` · ${props.item.sendStatus?.reason}` : ''}</span>}>
          <span ref={setFailureRoot} style={{ 'max-width': '100%' }} />
        </Show>
        <Show when={!manual() && commands().onRetrySend && props.item.sendStatus?.retryable !== false}>
          <button type="button" onClick={() => commands().onRetrySend?.(props.item.id)}
            style={{ color: 'inherit', cursor: 'pointer', 'flex-shrink': 0 }}>{t('transcript.retrySend')}</button>
        </Show>
      </div>
    </Show>
  </>;
}
