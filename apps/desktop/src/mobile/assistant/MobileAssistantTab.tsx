import type { AssistantChatHandlers } from '@/components/assistant/AssistantChatSlot'
import { MobileAssistantApp, type PhoneRoute } from './MobileAssistantApp'
import { MobileAssistantGate } from './MobileAssistantGate'
import type { PhoneAssistantState } from './usePhoneAssistant'

/**
 * #7199 手机上的咕咕:「消息」置顶第一行推进来的整屏一层(owner 10-26,OpenDCAI/gugu#446;取代 10-16「底栏里的一格」)。
 * 能打开和它的私聊 = 助理 App 本身;还不能(没开通 / 正在准备 / 读不到 / 私聊在开)= 同一层里说是哪一步。
 */
export function MobileAssistantTab({ state, visible, chatRequest, initialRoute, navigationTarget, onExit, ...chatHandlers }: {
  state: PhoneAssistantState
  visible: boolean
  /** 每变一次 = 别处打开了和它的私聊(对话列表、通知、联系人「发消息」):落在聊天那一段。 */
  chatRequest: number
  /** 外壳从「我的」推进来时直接停在资料段。 */
  initialRoute?: PhoneRoute
  navigationTarget?: boolean
  /** 页头左上返回:退回外壳的上一层。 */
  onExit?: () => void
} & AssistantChatHandlers) {
  if (state.stage.stage !== 'ready' || !state.assistant || !state.chatId) {
    return <MobileAssistantGate stage={state.stage.stage === 'ready' ? { stage: 'chat-opening' } : state.stage} name={state.assistant?.display_name ?? null} ownerName={state.ownerName} onExit={onExit} />
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
      initialRoute={initialRoute}
      navigationTarget={navigationTarget}
      onExit={onExit}
      {...chatHandlers}
    />
  )
}
