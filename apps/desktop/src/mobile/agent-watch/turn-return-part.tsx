import { makeAssistantDataUI } from '@assistant-ui/react'
import type { ReactElement } from 'react'
import { conversationLink } from '@gugu/core/shared/ui/conversationLink'
import { ChevronRight } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { openConversationLink } from '@/lib/conversationLinks'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { useChatStore } from '@/store/chatContext'
import { TURN_RETURN_DATA_PART, type TurnReturnData } from './thread-messages'

/**
 * 这一轮的结果回到了哪个群(gugu-dev#181「已回到 X」),同桌面会话页那一行(session-chat-ui 的 turn-return):
 * 字是同一句,点它跳到它发进群的那条消息(拿不到就跳到群)。群名读手机自己的聊天列表,认不出就「已回到群聊」。
 */
function TurnReturnPart({ data }: { data: TurnReturnData }): ReactElement {
  const { chats } = useChatStore('chats')
  const name = chats.find((chat) => chat.id === data.chatId)?.name || null
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="mobile-turn-return"
      className="min-w-0 gap-1 px-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]"
      onClick={() => openConversationLink(conversationLink(data.chatId, data.messageId ?? undefined))}
    >
      <span className="truncate">
        {name ? translateSessionMessage('transcript.turnReturned', { chat: name }) : translateSessionMessage('transcript.turnReturnedUnnamed')}
      </span>
      <ChevronRight size={12} />
    </Button>
  )
}

export const TurnReturnDataUI = makeAssistantDataUI<TurnReturnData>({ name: TURN_RETURN_DATA_PART, render: TurnReturnPart })
