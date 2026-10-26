import { useEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Search } from '@/lib/icons'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { SearchField } from './SearchField'
import { useBackLayer } from './sheetStack'
import { UI_EVENTS } from '@/lib/uiEvents'

/**
 * @@@header-search — 手机搜索展开在页头；两个列表首页从底部搜索钮打开(owner 10-26)，推进页沿用页头放大镜。
 * 传 externalTrigger 时不画页头入口；其他页交出一颗放大镜。点开后「搜索框 + 取消」
 * 盖在页头上并聚焦。取消 = 收起并清空,安卓返回键同它。
 * 盖而不换:页头留在原处只是看不见,几何不变(各页页头高矮不一,换掉会让列表跳一下),页头自己登记的返回层也还在下面。
 * 只管框放在哪:搜索词仍是页面自己那份(value / onChange),过滤与结果一处不改。桌面不走这里:
 * mobile 为假时只交出 null,页面照旧画自己的常驻框。
 * 有搜索词就一直展开:页面卸载再挂回(联系人从结果点进详情再返回)时,框跟着词一起回来。
 */
export function HeaderSearch({ mobile, active = true, value, onChange, onKeyDown, placeholder, testId, externalTrigger, children }: {
  mobile: boolean
  /** 这一页此刻在屏上。被别的 tab / 整页盖住时它还挂着,返回键不能归一个看不见的框。 */
  active?: boolean
  value: string
  onChange: (value: string) => void
  /** 页面自己那份框上的键盘处理(联系人的 ↑↓ / 回车开结果),原样接到这个框上。 */
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  placeholder: string
  /** 展开后搜索框的 testid:沿用页面原来那颗常驻框的。 */
  testId?: string
  /** 列表首页由底部搜索钮打开，保留本页原有输入、过滤和返回行为。 */
  externalTrigger?: string
  /** 收到放大镜(桌面是 null),画出这一页原来的页头。 */
  children: (searchButton: ReactNode) => ReactNode
}) {
  const { t } = useTranslation('messaging')
  const [opened, setOpened] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = mobile && (opened || value !== '')
  const close = () => {
    setOpened(false)
    onChange('')
  }
  useBackLayer(close, open && active)
  useEffect(() => {
    if (!mobile || !active || !externalTrigger) return
    const show = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail !== externalTrigger) return
      // 同一次用户手势中挂载并聚焦，手机浏览器才能弹键盘。
      flushSync(() => setOpened(true))
      inputRef.current?.focus()
    }
    window.addEventListener(UI_EVENTS.openPhoneListSearch, show)
    return () => window.removeEventListener(UI_EVENTS.openPhoneListSearch, show)
  }, [mobile, active, externalTrigger])

  if (!mobile) return children(null)
  return (
    <div data-header-search={open || undefined} className={open ? 'relative shrink-0 [&>:not([data-header-search-field])]:invisible' : 'relative shrink-0'}>
      {children(externalTrigger ? null : (
        <IconButton data-header-search-open="" aria-label={placeholder} title={placeholder} onClick={() => setOpened(true)}>
          <Search />
        </IconButton>),
      )}
      {open ? (
        <div data-header-search-field="" className="absolute inset-0 flex items-center gap-1 px-[var(--pane-pad-x)]">
          <SearchField
            ref={inputRef}
            autoFocus={opened}
            className="flex-1"
            data-testid={testId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            clearLabel={t('chatList.clearSearch')}
            onClear={() => onChange('')}
          />
          <Button variant="ghost" size="sm" className="shrink-0" data-header-search-cancel="" onClick={close}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
