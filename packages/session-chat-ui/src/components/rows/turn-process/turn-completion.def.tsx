/** @jsxImportSource solid-js */
/**
 * 只调了工具、一句没说的那一轮末尾的复制(#7324)。
 *
 * 长相与出现时机跟同一布局里消息下面那颗复制完全一样,文案只写「复制」(#1041,owner:「我没悬浮也显示复制按钮」
 * 「复制按钮就写复制就行」):对话布局 = 气泡下面那排操作,同一个组件,只有图标、鼠标停在这一行才出现;
 * 经典布局 = 回复页脚那颗「复制」,鼠标停在这一行才出现。
 */
import { CopyButton } from '@session-chat/components/primitives/CopyButton';
import { messageGroup } from '@session-chat/components/primitives/copy-button.css';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { defineUnit } from '@session-chat/core/units';
import type { TurnCompletionItem } from '@session-chat/model';
import { UserMessageActions } from '../message/UserMessageActions';
import { CONVERSATION_FOOTER_H } from '../message/conversation-body';
import { conversationRoot } from '../message/conversation-message.css';
import { userMessageActionsHeight } from '../message/metrics';
import { completionActions } from './turn-completion.css';
import { Show } from 'solid-js';

const CONVERSATION_VARS = { footerH: CONVERSATION_FOOTER_H };

export const turnCompletionUnitDef = defineUnit<TurnCompletionItem, { height: number }>({
  kind: 'turn-completion',
  margin: { top: 4, bottom: 4 },
  vars: { height: 24 },
  measure(_data, ctx, vars) {
    return ctx.theme.layout.agentConversation ? userMessageActionsHeight(CONVERSATION_VARS) : vars.height;
  },
  Render(props) {
    const theme = useTheme();
    return (
      <Show when={theme().layout.agentConversation} fallback={
        <div class={`${completionActions} ${messageGroup}`} data-slot="turn-completion" data-turn-id={props.data.turnId}
          style={{ height: `${props.vars.height}px` }}>
          <Show when={props.data.id} keyed>
            {(_id) => <CopyButton text={props.data.text} variant="inline" />}
          </Show>
        </div>
      }>
        <div class={conversationRoot} data-side="left" data-slot="turn-completion" data-turn-id={props.data.turnId}>
          <UserMessageActions itemId={props.data.id} text={props.data.text} generating={false} readOnly vars={CONVERSATION_VARS} />
        </div>
      </Show>
    );
  },
});
