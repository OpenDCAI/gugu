import type { ReactNode } from 'react'
import { composerSlotClass, composerSlotInnerClass } from '@gugu/session-chat-ui/composer-layout'

/**
 * The desktop composer uses the same slot frame as ACP tasks.
 *
 * 底部那一摞排在消息流下面,不浮在消息流上(owner 10-25):消息流的滚动区在 `above`(运行条那一行)的上沿结束,
 * 消息不会滚到运行条和输入框后面。`above` 是真占位的一行:固定高度、透明、没有底,里面有没有东西都不改变这一摞的高度,
 * 所以运行条出现、消失不改变布局。回复条和输入框那一层的底色与聊天栏同一个 token(--bg-primary)。
 * floating=false(手机):没有这层外框,照旧按顺序排在消息流下面。
 */
export function ChatBottomDock({ floating, above, children }: { floating: boolean; above?: ReactNode; children: ReactNode }) {
  if (!floating) return <>{above}{children}</>
  return (
    <div data-chat-bottom-dock="" className={`${composerSlotClass} relative! shrink-0`}>
      {above ? <div className={`${composerSlotInnerClass} pb-0!`}>{above}</div> : null}
      <div className={`${composerSlotInnerClass} bg-[var(--bg-primary)]`}>{children}</div>
    </div>
  )
}
