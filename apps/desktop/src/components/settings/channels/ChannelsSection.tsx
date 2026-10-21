import { ChatChannelsPanel } from './ChatChannelsPanel'

/** 设置 →「聊天渠道」:兼容入口;正式落点是「助理」App 的「能力 · 聊天工具」页,两处是同一块 ChatChannelsPanel。 */
export function ChannelsSection() {
  return (
    <div data-testid="settings-channels">
      <ChatChannelsPanel />
    </div>
  )
}
