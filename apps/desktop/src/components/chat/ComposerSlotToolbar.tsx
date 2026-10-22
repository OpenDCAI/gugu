import type { ReactNode } from 'react'
import { sessionComposerBox } from '../../session/renderer/features/sessions/session-composer-styles'

// gugu-dev#181 格子里(项目块、对话块)的聊天输入框:
// 底排的位置和间距同会话框(sessionComposerBox)。
const toolbarStyle = {
  gap: sessionComposerBox.toolbarGapPx,
  height: sessionComposerBox.toolbarControlPx,
  padding: `0 ${sessionComposerBox.toolbarInsetPx}px ${sessionComposerBox.toolbarInsetPx}px`,
  boxSizing: 'content-box',
} as const

/** 框内底排:「+ 新任务 定时任务 … 发送」。 */
export function ComposerSlotToolbar({ start, end }: { start: ReactNode; end: ReactNode }) {
  return (
    <div className="flex items-center" style={toolbarStyle}>
      {start}<span className="flex-1" />{end}
    </div>
  )
}
