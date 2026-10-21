import { Markdown } from '@/components/markdown/Markdown'
import { AssistantTodayFeed } from '@/session/renderer/features/assistant/assistant-today-feed'
import { WidgetDiscover } from '@/session/renderer/features/assistant/assistant-widget-discover'
import type { PhonePageProps } from './MobileAssistantApp'
import { usePhoneToday } from './usePhoneToday'

/**
 * 手机上的「动态」那一格:today.json(usePhoneToday)画成与桌面同一个信息流。
 * 「添加组件」推一页「发现组件」(sub = discover,左上箭头回来;❌ 底部抽屉);「来源」里的「管理连接」去 <它的名字> 那一格的连接应用。
 */
export function PhoneToday({ assistant, chatId, ownerName, askInChat, sub, go, open }: PhonePageProps) {
  const view = usePhoneToday(chatId)
  if (sub === 'discover') return <WidgetDiscover layout="page" name={assistant.display_name} askInChat={askInChat} onClose={() => go(null)} />
  return (
    <AssistantTodayFeed
      view={view}
      assistantName={assistant.display_name}
      ownerName={ownerName}
      askInChat={askInChat}
      renderMarkdown={(markdown) => <Markdown trust="chat" content={markdown} />}
      onAddWidget={() => go('discover')}
      onManageConnectors={() => open({ tab: 'profile', sub: 'connectors' })}
    />
  )
}
