import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { Button } from '@/components/ui/Button'
import { MessageCircle, Search, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { UI_EVENTS } from '@/lib/uiEvents'
import { tabItemStyle } from './settledTab'
import type { PhoneViewport } from './usePhoneViewport'

const anchorStyle = (height: number, index: number): CSSProperties => ({ '--phone-nav-viewport-height': `${height}px`, '--phone-nav-selected-index': index }) as CSSProperties

/** 编辑时保持原布局锚点，让缩小的可视区/系统键盘盖住底栏；焦点本身不隐藏底栏。 */
function useNavHeight(viewport: PhoneViewport): number {
  const [height, setHeight] = useState(window.innerHeight)
  const width = useRef(window.innerWidth)
  useLayoutEffect(() => {
    const rotated = width.current !== window.innerWidth
    width.current = window.innerWidth
    if (rotated || (!viewport.inputFocused && viewport.keyboardVisible !== true)) setHeight(window.innerHeight)
  }, [viewport.viewportHeight, viewport.inputFocused, viewport.keyboardVisible])
  return height
}

export function PhoneTabBar({ activeTab, onTabChange, pendingContactsCount, barRef, tabs, viewport }: {
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  pendingContactsCount: number
  barRef: RefObject<HTMLElement | null>
  tabs: readonly SidebarTab[]
  viewport: PhoneViewport
}) {
  const { t } = useTranslation('main')
  const { t: mt } = useTranslation('messaging')
  const height = useNavHeight(viewport)
  const entries = {
    chats: { label: t('shell.messagesMobile'), icon: <MessageCircle />, testId: AUTOMATION_TEST_IDS.mobileMessagesNav },
    contacts: { label: t('shell.partnersMobile'), icon: <Users />, testId: AUTOMATION_TEST_IDS.mobileContactsNav },
  }
  return (
    <nav ref={barRef} data-phone-tabbar="" className="gg-phone-nav" style={anchorStyle(height, tabs.indexOf(activeTab))}>
      <div className="gg-phone-nav-destinations">
        {tabs.map((tab, index) => {
          const item = tab === 'chats' || tab === 'contacts' ? entries[tab] : null
          if (!item) return null
          return <Button key={tab} variant="ghost" className="gg-phone-nav-item" aria-label={item.label} aria-current={tab === activeTab ? 'page' : undefined} data-testid={item.testId} onClick={() => onTabChange(tab)} style={tabItemStyle(index, tabs.indexOf(activeTab), 'var(--primary)')}>
            <span className="gg-phone-nav-icon">{item.icon}{tab === 'contacts' && pendingContactsCount > 0 ? <span className="gg-phone-nav-badge">{pendingContactsCount > 99 ? '99+' : pendingContactsCount}</span> : null}</span>
            <span>{item.label}</span>
          </Button>
        })}
      </div>
      <Button variant="ghost" className="gg-phone-nav-search" data-testid="phone-list-search" aria-label={mt('chatList.search')} onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.openPhoneListSearch, { detail: activeTab }))}><Search /></Button>
    </nav>
  )
}
