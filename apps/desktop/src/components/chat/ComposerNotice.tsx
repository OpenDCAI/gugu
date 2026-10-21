import type { CSSProperties, ReactNode } from 'react'

// @@@notice-bar (Refs #6105) 输入框旁那条说明的唯一实现:私聊 / 群里 @ 的通知(AgentComposerNotices、AgentMentionStatusNotice)
// 和会话页新建框的「云电脑休眠中」(#7199)共用 —— 形状定义一次,调用点只给内容。说明状态用它,报错 ❌ 用它。
// 零依赖:会话页那一棵也引它。
const NOTICE_STYLE: CSSProperties = {
  margin: '0 0 6px', padding: '7px 10px', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-document)', background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)', fontSize: 'var(--font-body)', display: 'flex', alignItems: 'center', gap: 10,
}

export function ComposerNotice({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string> & { style?: CSSProperties }) {
  return <div data-composer-notice="" {...rest} style={{ ...NOTICE_STYLE, ...rest.style }}>{children}</div>
}
