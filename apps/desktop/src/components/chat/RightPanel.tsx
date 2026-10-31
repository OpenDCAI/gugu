import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from '@/lib/icons'
import { DUR_SLOW_MS, EASE_SPRING, tween } from '@/styles/motion'
import { useMobileShell } from '../../hooks/useMobileShell'
import { IconButton } from '../ui/IconButton'
import { useBackLayer } from '../ui/sheetStack'
import { rightPanelMobilePageStyle } from './rightPanelMobilePage'

const RIGHT_PANEL_DEFAULT_WIDTH = 360

// 聊天区右侧那一个槽位的外壳(成员列表 / 群设置 / 群公告 / 历史;工作区只在手机上 —— 桌面上它和会话页右栏是同一个 SidePanelSplit):与消息列并排、把它挤窄,左边一道
// 常态 hairline。宽度与边线只归这里管,里面的面板撑满外壳。
// ❌ 阴影、❌ 遮罩 —— 它是分栏不是浮层。进场滑入,❌ exit(退场还占宽,消息列会回弹跳闪)。
// 开关与同槽位互斥归 ChatAreaPanel 的 closeRightSurfaces,两栏按各自的 flex 收缩。
const shellStyle: CSSProperties = {
  flexShrink: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto',
  background: 'var(--bg-primary)', borderLeft: '1px solid var(--border)',
}
const mobileScrollPageStyle: CSSProperties = { ...rightPanelMobilePageStyle, overflow: undefined, overflowY: 'auto' }

/**
 * `scroll`:手机外壳自己滚动;不给则由内容自带滚动区。桌面外壳始终允许滚动,不裁掉窄窗内容。
 * `onClose`:手机上安卓返回键先关它(同左上返回);页头自己已经接返回键的(SettingsPageHead)不传。
 * `width`:桌面首选宽度,窄窗可收缩;`'fill'` = 撑满所嵌的栏,边线归那一栏。手机上一律整页。
 */
export function RightPanel({ children, scroll = false, width = RIGHT_PANEL_DEFAULT_WIDTH, testId, onClose }: { children: ReactNode; scroll?: boolean; width?: number | 'fill'; testId?: string; onClose?: () => void }) {
  const mobile = useMobileShell()
  useBackLayer(onClose, mobile)
  const desktopWidth = width === 'fill' ? { width: '100%', borderLeft: 'none' } : { width }
  return (
    <motion.div
      data-testid={testId}
      initial={mobile ? { x: '100%' } : { x: RIGHT_PANEL_DEFAULT_WIDTH, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={mobile ? { x: '100%' } : undefined}
      transition={tween(DUR_SLOW_MS, EASE_SPRING)}
      style={mobile ? (scroll ? mobileScrollPageStyle : rightPanelMobilePageStyle) : { ...shellStyle, ...desktopWidth }}
    >
      {children}
    </motion.div>
  )
}

/** 手机整页的出口:左上返回(#1787 手机导航规范);桌面仍是各面板自己右上的关闭。 */
export function RightPanelBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('messaging')
  return (
    <IconButton size="lg" aria-label={t('common.back')} title={t('common.back')} onClick={onBack}>
      <ChevronLeft />
    </IconButton>
  )
}
