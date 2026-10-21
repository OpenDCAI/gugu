import { useBackLayer } from '@/components/ui/sheetStack'
import { IdeasPanel } from '@/session/renderer/features/assistant/assistant-ideas'
import type { PhoneAssistant } from './MobileAssistantApp'
import { usePhoneToday } from './usePhoneToday'

/**
 * 手机上的「灵感」面板:盖在聊天上面一整页(❌ 底部抽屉),安卓返回键先关它。只在打开时读 today.json
 * (胶囊本身不用读:没有灵感也露着,点开是空态 +「让它想几个」)。
 */
export function PhoneIdeas({ assistant, chatId, askInChat, onClose }: { assistant: PhoneAssistant; chatId: string; askInChat: (draft: string) => void; onClose: () => void }) {
  const view = usePhoneToday(chatId)
  useBackLayer(onClose, true)
  return (
    <div className="ta-phone-layer" data-testid="mobile-assistant-ideas">
      <IdeasPanel layout="page" view={view} assistantId={assistant.id} name={assistant.display_name} askInChat={askInChat} onClose={onClose} />
    </div>
  )
}
