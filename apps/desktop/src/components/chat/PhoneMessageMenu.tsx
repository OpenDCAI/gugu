import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu'
import { DeferredEmojiQuickPicker } from './messageActionModules'
import type { MessageActionItem } from './messageActionItems'
import { LIFT_SCALE, phoneMenuLayout, type PhoneMenuLayout, type Rect } from './phoneMessageMenuLayout'
import './phoneMessageMenu.css'

/**
 * 手机长按一条消息(owner 11-05 选定方案 A):背景压暗、模糊,被按的气泡浮起来,
 * 回应条在它上方、动作列表在它下方,从气泡边上弹出。动作就是桌面右键那一份 messageActionItems(),只是摆法不同:
 * 手指会挡住内容、没有悬停,所以要把「按的是哪条」举到眼前;桌面照旧是指针处的右键菜单。
 */
export function PhoneMessageMenu({ open, bubble, touchY, mine, items, reactionsDisabled, onReact, onClose }: {
  open: boolean
  bubble: RefObject<HTMLElement | null>
  touchY: number
  mine: boolean
  items: MessageActionItem[]
  reactionsDisabled: boolean
  onReact: (emoji: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  // 整屏一张透明浮层,子块按屏幕坐标摆;点到空处落在下面的遮罩上 = 菜单外,收起。
  return (
    <Menu open={open} x={0} y={0} minWidth={0} ariaLabel={t('message.actions.more')} onClose={onClose}
      popupClassName="gg-phone-menu" backdropClassName="gg-phone-menu-scrim">
      <PhoneMenuBody bubble={bubble} touchY={touchY} mine={mine} items={items} reactionsDisabled={reactionsDisabled} onReact={onReact} onClose={onClose} />
    </Menu>
  )
}

// 浮层内容在 portal 挂上以后才有;量尺寸、克隆气泡都在这一层的 layout effect 里做(先于首帧绘制)。
function PhoneMenuBody({ bubble, touchY, mine, items, reactionsDisabled, onReact, onClose }: Omit<Parameters<typeof PhoneMessageMenu>[0], 'open'>) {
  const [expanded, setExpanded] = useState(false)
  const [layout, setLayout] = useState<PhoneMenuLayout & { from: number }>()
  const frameRef = useRef<HTMLDivElement>(null)
  const reactionsRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // 打开那一刻气泡在哪:之后原气泡藏起来、列表也可能滚动,版面只认这一份。
  const origin = useRef<{ rect: Rect; radius: string }>(undefined)

  useLayoutEffect(() => {
    const source = bubble.current
    const preview = previewRef.current
    if (!source || !preview) return
    const r = source.getBoundingClientRect()
    origin.current = { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, radius: getComputedStyle(source).borderRadius }
    // 预览是原气泡的一份静态拷贝:只给人看,❌ 可点、❌ 进无障碍树(真身还在原处,菜单收起就回来)。
    const copy = source.cloneNode(true) as HTMLElement
    for (const el of [copy, ...copy.querySelectorAll('[id], [data-testid]')]) { el.removeAttribute('id'); el.removeAttribute('data-testid') }
    copy.style.width = `${r.width}px`
    copy.style.maxWidth = 'none'
    copy.style.visibility = 'visible'
    copy.inert = true
    preview.replaceChildren(copy)
    // 真身让位给浮起的那份,收起动画落回原处、浮层卸载时再露出来 —— 看上去就是同一条气泡浮起又落下。
    source.style.visibility = 'hidden'
    return () => { source.style.visibility = '' }
  }, [bubble])

  // 回应条是延迟加载的、展开表情会变高:尺寸一变就重排(首帧之前先排一次)。
  useLayoutEffect(() => {
    const measure = () => {
      const frame = frameRef.current?.getBoundingClientRect()
      // 子块按浮层自己的坐标摆;浮层被定位器挪过多少(碰撞边距)就减回来。
      const host = frameRef.current?.parentElement?.getBoundingClientRect()
      // offset* 是没变形的尺寸:它们正带着 scale 弹出来,getBoundingClientRect 量到的是缩小的那一帧。
      const size = (el: HTMLElement | null) => ({ width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 })
      if (!origin.current || !frame || !host) return
      const bubble = { ...origin.current.rect, top: origin.current.rect.top - host.top, left: origin.current.rect.left - host.left }
      const next = phoneMenuLayout({
        bubble, touchY: touchY - host.top, mine,
        // frame 在浮层里按安全区内缩;浮层本身和屏幕一样大,所以安全区在屏幕上的位置 = frame.top - host.top,再换回浮层坐标。
        viewport: { top: frame.top - 2 * host.top, width: frame.width, height: frame.height },
        reactions: size(reactionsRef.current),
        list: size(listRef.current),
      })
      setLayout({ ...next, from: bubble.top + next.clipTop - next.preview.top })
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of [frameRef.current, reactionsRef.current, listRef.current]) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, touchY, mine])

  const clipped = !!layout && !!origin.current && layout.preview.height < origin.current.rect.height
  const place = (box: { top: number; left: number } | undefined, extra?: CSSProperties): CSSProperties =>
    box ? { top: box.top, left: box.left, ...extra } : { top: 0, left: 0, visibility: 'hidden', ...extra }
  const danger = items.findIndex((item) => item.danger)

  return (
    <>
      <div ref={frameRef} className="gg-phone-menu-frame" aria-hidden />
      <div ref={previewRef} className="gg-phone-menu-preview" aria-hidden onClick={onClose}
        data-clipped-top={(layout?.clipTop ?? 0) > 0 || undefined} data-clipped-bottom={clipped && layout && origin.current && layout.clipTop + layout.preview.height < origin.current.rect.height || undefined}
        style={place(layout?.preview, { width: layout?.preview.width, height: layout?.preview.height, borderRadius: origin.current?.radius, '--lift-from': `${layout?.from ?? 0}px`, '--lift-scale': LIFT_SCALE, '--clip-top': `${-(layout?.clipTop ?? 0)}px` } as CSSProperties)} />
      {!reactionsDisabled && (
        <div ref={reactionsRef} className="gg-phone-menu-reactions" data-expanded={expanded || undefined}
          style={place(layout?.reactions, { '--origin': mine ? '100% 100%' : '0 100%' } as CSSProperties)}>
          <DeferredEmojiQuickPicker menu onPick={onReact} onClose={onClose} onExpand={() => setExpanded(true)} />
        </div>
      )}
      {!expanded && (
        <div ref={listRef} className="gg-phone-menu-list" data-testid="message-action-menu"
          style={place(layout?.list, { '--origin': mine ? '100% 0' : '0 0' } as CSSProperties)}>
          {items.map((item, index) => (
            <Fragment key={item.key}>
              {index === danger && index > 0 && <MenuSeparator />}
              <MenuItem icon={<item.icon size={18} />} disabled={item.disabled} danger={item.danger} data-testid={`message-action-${item.key}`}
                onClick={item.onSelect ? () => { item.onSelect?.(); onClose() } : undefined}>
                {item.label}
              </MenuItem>
            </Fragment>
          ))}
        </div>
      )}
    </>
  )
}
