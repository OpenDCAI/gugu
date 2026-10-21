import { useEffect, useRef } from 'react'
import { SearchField } from '../../components/ui/SearchField'

/**
 * 发现页的搜索框。
 *
 * 刻意做成「谁用谁自带一个」而不是页面壳上摆一个公用的：工作台搜的是团队和 Agent，
 * 找群搜的是公开群 —— 两件事共用一个输入框的话，在工作台敲的词会被原样带去搜群。
 * 而且公用那一个原本挂在子标签**上方**，只在「找群」时出现，导致来回切子标签时
 * 整行位置上下跳。控件放进它真正管辖的那块里，两个毛病一起没了。
 */
export function DiscoverSearchField({
  value,
  onChange,
  placeholder,
  shortcutEnabled,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** 只有当前可见的那个 pane 才接 ⌘F，否则两个隐藏的输入框会抢焦点。 */
  shortcutEnabled: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  // ⌘F / Ctrl+F 聚焦搜索。Mac 用户找东西的第一反应就是这个键；
  // 有搜索框却不接 ⌘F，在 Mac 上会被当成半成品(HIG 5.1)。
  useEffect(() => {
    if (!shortcutEnabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey) return
      e.preventDefault()
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [shortcutEnabled])

  return (
    <SearchField
      ref={ref}
      className="gg-dsearch mb-5"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
