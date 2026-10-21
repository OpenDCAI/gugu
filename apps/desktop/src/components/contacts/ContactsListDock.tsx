import { useTranslation } from 'react-i18next'
import { ListChecks, Users } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Button } from '../ui/Button'

/**
 * @@@4322-selection-dock — 联系人列表底边的坞。多选态摆已选计数与批量建群动作；移动壳普通态也在，摆摘要
 * 与多选入口（桌面的入口在头部）。形态理由与「勾选途中零位移」的作用域见 spec `contact-multiselect`。
 * 两条只在代码里看得见的：① 多选态**分两行**是那条零位移的前提——并排时折不折行是「计数宽度 + 动作宽度
 * vs 容器宽度」的函数，于是有一段宽度让 `已选 9 人` 放得下、`已选 10 人` 放不下，勾到第 10 个人时坞长高
 * 一行；分行后高度与计数、与 locale 无关（普通态不需要这条，保持紧凑一行）。② 容器的 padding 走内联。
 */
export function ContactsListDock({ mobile = false, selectionMode, selectedCount, summaryLabel, canEnterSelectionMode = false, onEnterSelectionMode, onCreateGroupFromSelection }: {
  mobile?: boolean
  selectionMode: boolean
  selectedCount: number
  summaryLabel?: string  // 不传 ⇒ 普通态不渲染坞（桌面面板即如此）
  canEnterSelectionMode?: boolean
  onEnterSelectionMode?: () => void
  onCreateGroupFromSelection: () => void
}) {
  const { t } = useTranslation('contacts')
  if (!selectionMode && !summaryLabel) return null
  const label = `truncate ${mobile ? 'text-[length:var(--font-title)]' : 'text-[length:var(--font-body)]'}`
  const size = mobile ? 'lg' : 'md'
  return (
    <div
      className={`flex shrink-0 gap-2 border-t border-[var(--border-color)] text-[var(--text-secondary)] ${selectionMode ? 'flex-col items-stretch' : 'flex-row items-center'}`}
      style={{ padding: mobile ? 'var(--spacing-sm) var(--spacing-md)' : 'var(--spacing-sm) var(--spacing-md) var(--spacing-md)' }}
    >
      {selectionMode ? (
        <>
          <span className={label}>{t('panel.selectedCount', { count: selectedCount })}</span>
          <Button variant="primary" size={size} className="w-full" data-testid={AUTOMATION_TEST_IDS.contactsCreateGroupFromSelection} disabled={selectedCount === 0} onClick={onCreateGroupFromSelection}><Users size={mobile ? 16 : 14} />{t('panel.createGroupWithSelected')}</Button>
        </>
      ) : (
        <>
          <span className={`min-w-0 flex-1 ${label}`}>{summaryLabel}</span>
          {canEnterSelectionMode && onEnterSelectionMode ? <Button variant="ghost" size={size} className="shrink-0" data-testid={AUTOMATION_TEST_IDS.contactsSelectModeButton} onClick={onEnterSelectionMode}><ListChecks size={mobile ? 16 : 14} />{t('panel.selectMode')}</Button> : null}
        </>
      )}
    </div>
  )
}
