import type { AssistantChatHandlers } from '@/components/assistant/AssistantChatSlot'
import { MobileAssistantApp } from './MobileAssistantApp'
import { MobileAssistantGate } from './MobileAssistantGate'
import type { PhoneAssistantState } from './usePhoneAssistant'

/**
 * #7199 手机底栏「助理」那一格(owner 10-16:「助理是咕咕底栏里的一格」,咕咕底栏一直在,❌ 进去换成第二排底栏):
 * 能打开和它的私聊 = 助理 App 本身;还不能(没开通 / 正在准备 / 读不到 / 私聊在开)= 同一格里说是哪一步。
 */
export function MobileAssistantTab({ state, visible, chatRequest, ...chatHandlers }: {
  state: PhoneAssistantState
  visible: boolean
  /** 每变一次 = 别处打开了和它的私聊(对话列表、通知、联系人「发消息」):落在聊天那一段。 */
  chatRequest: number
} & AssistantChatHandlers) {
  if (state.stage.stage !== 'ready' || !state.assistant || !state.chatId) {
    return <MobileAssistantGate stage={state.stage.stage === 'ready' ? { stage: 'chat-opening' } : state.stage} name={state.assistant?.display_name ?? null} ownerName={state.ownerName} />
  }
  return (
    <MobileAssistantApp
      chatId={state.chatId}
      assistant={state.assistant}
      ownerName={state.ownerName}
      homeDeviceId={state.homeDeviceId}
      cloudDeviceId={state.cloudDeviceId}
      home={state.home}
      visible={visible}
      chatRequest={chatRequest}
      {...chatHandlers}
    />
  )
}
