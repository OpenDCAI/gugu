/** @jsxImportSource solid-js */
import { conversationLink } from '@gugu/core/shared/ui/conversationLink';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconChevronRight } from '@session-chat/components/primitives/icons';
import { defineUnit } from '@session-chat/core/units';
import { useChatName } from '@session-chat/lib/chat-name';
import { useChatTranslator } from '@session-chat/localization';
import type { TurnReturnItem } from '@session-chat/model';
import { turnReturnLink, turnReturnRow } from './turn-return.css';

/**
 * 这一轮的结果回到了哪个群(gugu-dev#181「已回到 X」):一行,点它跳到它发进群的那条消息(拿不到那条就跳到群)。
 * 只在这一轮真的往它来的那个群发过时才有这一行(判据 `replyReturn`),答案本身照旧折在过程里 —— 结果在群里。
 */
export const turnReturnUnitDef = defineUnit<TurnReturnItem, { height: number }>({
  kind: 'turn-return',
  margin: { top: 4, bottom: 4 },
  vars: { height: 24 },
  measure(_data, _ctx, vars) { return vars.height; },
  Render(props) {
    const translate = useChatTranslator();
    const chatName = useChatName();
    const commands = useCommands();
    const label = () => {
      const name = chatName(props.data.chatId);
      return name ? translate('transcript.turnReturned', { chat: name }) : translate('transcript.turnReturnedUnnamed');
    };
    return (
      <div class={turnReturnRow} data-slot="turn-return" data-turn-id={props.data.turnId} style={{ height: `${props.vars.height}px` }}>
        <button
          type="button"
          class={turnReturnLink}
          onClick={() => commands().onOpenConversationLink?.(conversationLink(props.data.chatId, props.data.messageId ?? undefined))}
        >
          {label()}
          <IconChevronRight />
        </button>
      </div>
    );
  },
});
