/** @jsxImportSource solid-js */
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { ConversationTextBody, conversationNarrationHeight, conversationTextKey } from './ConversationNarration';
import { segmentItem } from './DeliveryCard';
import * as styles from '../semantic-disclosure.css';

export const isScheduledPrompt = (item: ChatMessage): boolean => item.role === 'user'
  && item.guguDelivery?.segments.length === 1 && item.guguDelivery.segments[0].facts?.route === 'scheduled';

/** Split mixed delivery batches without attributing their other messages to a schedule. */
export function scheduledPromptParts(item: ChatMessage): ChatMessage[] {
  const segments = item.role === 'user' ? item.guguDelivery?.segments : undefined;
  return segments?.some(segment => segment.facts?.route === 'scheduled')
    ? segments.map((segment, index) => segments.length === 1 ? item : segmentItem(item, segment, index)) : [];
}

export function scheduledPromptHeight(parts: readonly ChatMessage[], ctx: MeasureCtx): number {
  return parts.reduce((total, part) => total + conversationNarrationHeight(part, ctx, true) + 12, 0);
}

export function ScheduledPrompt(props: { data: ChatMessage; anchorId: string; ctx: RenderCtx }) {
  const t = useChatTranslator();
  const title = () => props.data.guguDelivery?.segments[0]?.facts?.schedule;
  const label = () => title() ? t('transcript.scheduledTaskTitled', { title: title()! }) : t('transcript.scheduledTask');
  const expanded = () => props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
  return <div data-scheduled-prompt={props.data.id}>
    <div class={styles.row} data-slot="semantic-disclosure" style={{ height: '44px' }}>
      <button type="button" class={styles.toggle} data-slot="collapse-header" data-collapse-id={conversationTextKey(props.data.id)}
        data-collapse-anchor={props.anchorId} aria-expanded={expanded()} aria-label={label()} />
      <span class={styles.inline}>
        <span class={styles.label}>{label()}</span>
        <svg class={styles.chevron} style={{ transform: expanded() ? 'rotate(90deg)' : undefined }} viewBox="0 0 12 12" aria-hidden="true">
          <path d="m4 2.5 3.5 3.5L4 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </div>
    <ConversationTextBody data={props.data} ctx={props.ctx} canExpand />
  </div>;
}
