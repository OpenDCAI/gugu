import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { useListColumnCollapse } from '../hooks/useListColumnCollapse'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { ResizablePane } from './ResizablePane'
import {
  CHAT_LIST_PANE_MAX_WIDTH,
  CHAT_LIST_PANE_MIN_WIDTH,
  clampChatListPaneWidth,
  maxChatListPaneWidthForAvailableWidth,
} from './ResizableChatListPaneStorage'

/**
 * 会话列表那一栏。@@@5856 拖拽本身已抽到 ResizablePane —— 这里只剩「这一栏是谁」:
 * 它的夹取范围、它的名字、它的 test id,以及分割线贴在右边。它也是对话页的「列表栏」,可收起(#6753)。
 */
export function ResizableChatListPane({
  active,
  children,
  hidden,
  mobile,
  onWidthChange,
  onWidthCommit,
  width,
}: {
  /** 对话页在前台(桌面壳):这时它才接列表栏开关、快捷键与悬停。 */
  active: boolean
  children: ReactNode
  hidden: boolean
  mobile: boolean
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  width: number
}) {
  const { t } = useTranslation('main')
  const collapse = useListColumnCollapse(active && !mobile, width)
  return (
    <ResizablePane
      edge="right"
      hidden={hidden}
      mobile={mobile}
      width={width}
      minWidth={CHAT_LIST_PANE_MIN_WIDTH}
      initialMaxWidth={CHAT_LIST_PANE_MAX_WIDTH}
      clampWidth={clampChatListPaneWidth}
      maxWidthForAvailable={maxChatListPaneWidthForAvailableWidth}
      onWidthChange={onWidthChange}
      onWidthCommit={onWidthCommit}
      resizeLabel={t('shell.resizeChatList')}
      paneTestId={AUTOMATION_TEST_IDS.chatListPane}
      handleTestId={AUTOMATION_TEST_IDS.chatListPaneResizeHandle}
      collapse={collapse}
    >
      {children}
    </ResizablePane>
  )
}
