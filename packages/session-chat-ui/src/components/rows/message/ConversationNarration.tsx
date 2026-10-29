/** @jsxImportSource solid-js */
import { Show, createMemo } from 'solid-js';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import { plainTextBlock } from '@session-chat/core/markdown/to-html';
import type { ChatMessage } from '@session-chat/model';
import { CONVERSATION_NARRATION_H, conversationNarrationText } from './conversation-body';
import * as styles from './conversation-narration.css';
import { conversationTextTheme, narrationCanExpand } from './conversation-text-overflow';

export const conversationTextKey = (id: string) => `${id}:conversation-text`;

/** The expanded text uses the existing block measure/render contract, at the narration's 14/20 type. */
function textLayout(item: ChatMessage, ctx: MeasureCtx) {
  const theme = conversationTextTheme(ctx);
  const layout = layoutBlockStack([plainTextBlock(`${item.id}:full-text`, item.text)], { ...ctx, theme, width: Math.max(1, ctx.width - 20) });
  return { theme, layout };
}

export function conversationNarrationHeight(item: ChatMessage, ctx: MeasureCtx, canExpand = narrationCanExpand(item.text, ctx)): number {
  return CONVERSATION_NARRATION_H + (canExpand && ctx.isCollapsed(conversationTextKey(item.id)) ? textLayout(item, ctx).layout.height + 6 : 0);
}

export function ConversationTextBody(props: { data: ChatMessage; ctx: RenderCtx; canExpand?: boolean }) {
  const full = createMemo(() => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? textLayout(props.data, ctx) : null;
  });
  const expanded = () => (props.canExpand ?? (!!props.ctx.measureCtx && narrationCanExpand(props.data.text, props.ctx.measureCtx())))
    && props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
  return <Show when={expanded() && !!props.data.text.trim() && full()}>{value => <div class={styles.body}>
    <ThemeContext.Provider value={() => value().theme}><BlockStackView node={value().layout} /></ThemeContext.Provider>
  </div>}</Show>;
}

export function ConversationNarration(props: { data: ChatMessage; ctx: RenderCtx }) {
  const canExpand = () => !!props.ctx.measureCtx && narrationCanExpand(props.data.text, props.ctx.measureCtx());
  const expanded = () => props.ctx.viewState.isCollapsed(conversationTextKey(props.data.id));
  const height = () => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? conversationNarrationHeight(props.data, ctx, canExpand()) : CONVERSATION_NARRATION_H;
  };
  return <div class={styles.root} data-conversation-narration={props.data.id}
    data-conversation-terminal-reason={props.data.conversationTerminalReason || undefined}
    style={{ height: `${height()}px` }}>
    <button type="button" class={styles.trigger} data-collapse-id={canExpand() ? conversationTextKey(props.data.id) : undefined}
      data-collapse-anchor={props.data.id} aria-expanded={canExpand() ? expanded() : undefined} disabled={!canExpand()} title={props.data.text}>
      {conversationNarrationText(props.data.text)}
    </button>
    <ConversationTextBody {...props} canExpand={canExpand()} />
  </div>;
}
