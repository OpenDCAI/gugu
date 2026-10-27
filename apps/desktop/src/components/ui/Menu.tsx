/* eslint-disable react-refresh/only-export-components -- compound component namespaces are intentional. */

/**
 * Gugu menu composition: Base UI behavior + Gugu-owned tokens and styling.
 *
 * Two anchor shapes, one rule: a menu opened FROM AN ELEMENT (a button) anchors to that element, so
 * Base UI re-measures it on scroll/resize and the menu follows the button; only a pointer-opened
 * context menu (right click / long press) anchors to the pointer coordinate. ❌ Snapshotting
 * getBoundingClientRect() into x/y for a button — the list moves, the menu stays behind.
 * Collision handling is Base UI's alone (flip the side, shift along it); ❌ pre-flip by hand-estimated heights.
 */
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'
import { popupMotion } from './variants'
import { useBackLayer } from './sheetStack'

// @@@menu-variants - 菜单样式的唯一真相。`gg-menu*` 类名保留但不再承载样式:
// Sidebar.css 的 `.gg-sidebar-profile-actions .gg-menu-item-icon > svg` 按这些名字定位,
// 它们是稳定的语义锚点。
const menuPositioner = 'outline-none'

const menuPopup = cn(
  'gg-menu box-border overflow-hidden outline-none',
  // @@@float-one-edge (Refs #6104) — 浮层只画**一层抬起**,❌ 不再叠一圈描边。
  // design.md:「Do not stack a border, a ring, and a shadow on one edge.」
  // 原配方是 `border border-[var(--menu-border)]` + `shadow-[var(--shadow-lift)]`,两者共边。
  'rounded-[var(--radius-surface)]',
  'bg-[var(--menu-bg)] text-[var(--menu-fg)] shadow-[var(--shadow-lift)]',
  popupMotion,
)

// @@@menu-spacing - 菜单是可重复操作的控件组，弹层与每行都必须留出稳定的内容安全区。
// Inline padding keeps the spacing alive under the renderer's global reset without exempting the
// entire menu-item subtree from the reset.
// (这里刻意不写那个标签的字面量:scripts/check-ui-visual-spec.mjs 连注释一起数 rawButtons。)
// ⚠️ `w-full` 与 `text-left` 不能省:行可以经 `render` 换成原生按钮元素(头栏 ⋯ 菜单的「群公告 / 设置」),
// 而按钮 ① 即使 display:flex,宽度 auto 也按内容收缩(HTML 规范给 button 的 fit-content),不像 div 那样撑满 ⇒
// 可点范围与高亮只剩「图标 + 两个字」那一截,行右边大半截点了没反应(owner 2026-09-27 真机);
// ② 默认 text-align:center —— 撑满之后 flex-1 的文字格就把字摆到正中。
const menuItem = cn(
  // 手机(<720,与 ui/Button 同一条断点)行高到触控档,和手机上别的菜单一样高。
  'gg-menu-item box-border flex w-full min-h-9 max-[719px]:min-h-[var(--control-h-touch)] items-center gap-2 text-left outline-none',
  'rounded-[var(--radius-control)] text-[length:var(--font-body)] leading-[var(--line-height-base)]',
  'cursor-pointer select-none text-[var(--menu-fg)]',
  'transition-colors duration-[var(--dur-fast)] ease-out motion-reduce:transition-none',
  'data-[highlighted]:bg-[var(--menu-item-hover)]',
  '[&[data-pressed]:not([data-disabled])]:scale-[0.99]',
  'data-[variant=danger]:text-[var(--menu-danger)]',
  'data-[disabled]:cursor-default data-[disabled]:text-[var(--menu-icon)]',
)

const menuItemIcon = cn(
  'gg-menu-item-icon flex h-5 w-5 flex-[0_0_20px] items-center justify-center',
  'text-[var(--menu-icon)] [&>svg]:h-5 [&>svg]:w-5',
  'group-data-[variant=danger]/menu-item:text-[var(--menu-danger)]',
)

const menuItemLabel = 'gg-menu-item-label min-w-0 flex-1'

/**
 * 给自己画列表框的地方(输入框下面的下拉建议,role=listbox)复用菜单的外观:同一张浮层、同一种行,
 * 行的高亮同样挂 `data-highlighted`。❌ 另起一套下拉样式。
 * 浮层要 portal 出去(同菜单),❌ 画在面板里 —— 面板里后画的兄弟会盖在它上面、滚动容器会裁它。
 * 列表自己画的那一层(`<ul>` 与行)用 `p-1` / `px-[10px] py-[6px]`,与下面 Menu / MenuItem 的内联间距逐值相同。
 */
export const menuSurfaceClassName = menuPopup
export const menuRowClassName = menuItem
export const menuRowLabelClassName = menuItemLabel
const menuSurfacePadding = 4
const menuRowPadding = '6px 10px'

/** A pointer coordinate (context menu) or the element the menu was opened from. */
export type MenuAnchorProps =
  | { /** Pointer x of a context-menu gesture. */ x: number; /** Pointer y. */ y: number; anchor?: never }
  | { /** The trigger element (or its ref); Base UI keeps the menu attached to it. */ anchor: Element | RefObject<Element | null>; x?: never; y?: never }

export type MenuProps = MenuAnchorProps & {
  minWidth?: number
  /** Stacking order. Default var(--z-menu). */
  zIndex?: number | string
  style?: CSSProperties
  children: ReactNode
  /** Called for outside press, Escape, item selection, or another Base UI close request. */
  onClose?: () => void
  /** Accessible name for non-standard menu contents such as the quick reaction picker. */
  ariaLabel?: string
}

// 按钮锚点离按钮 6px(与 DropdownMenu 同);指针锚点贴着指针。
const ELEMENT_ANCHOR_OFFSET = 6

export function Menu({
  x,
  y,
  anchor: elementAnchor,
  minWidth = 160,
  zIndex = 'var(--z-menu)',
  style,
  children,
  onClose,
  ariaLabel,
}: MenuProps) {
  const pointAnchor = useMemo(() => (
    elementAnchor || x === undefined || y === undefined
      ? null
      : { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }
  ), [elementAnchor, x, y])
  // 开着的菜单也是盖在页面上的一层:安卓返回键先关它,❌ 让底下的页面退走、菜单浮在列表上。
  useBackLayer(onClose)

  return (
    <MenuPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose?.()
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          className={cn('gg-menu-positioner window-no-drag-region', menuPositioner)}
          anchor={elementAnchor ?? pointAnchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={elementAnchor ? ELEMENT_ANCHOR_OFFSET : 0}
          collisionPadding={8}
          // 放不下就翻到另一侧(下 → 上),沿边平移对齐;与 EmojiQuickPicker 同一套。
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
          style={{ zIndex }}
        >
          <MenuPrimitive.Popup
            className={menuPopup}
            data-occludes-browser-page
            aria-label={ariaLabel}
            style={{ minWidth: Math.max(minWidth, 0), padding: menuSurfacePadding, ...style }}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}

export interface MenuItemProps {
  /** 20px icon slot (e.g. a Solar icon from `@/lib/icons`). */
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** Native tooltip for a real action or its current availability. */
  title?: string
  className?: string
  style?: CSSProperties
  /** Test hook or product-specific DOM metadata. */
  'data-testid'?: string
  /** Optional element override, e.g. a semantic button in a trigger-anchored menu. */
  render?: MenuPrimitive.Item.Props['render']
  /** Required when `render` resolves to a native `<button>`. */
  nativeButton?: MenuPrimitive.Item.Props['nativeButton']
  /**
   * 右对齐的快捷键提示(应用菜单那种「粘贴  Ctrl+V」)。只写**真的按得出来**的组合 ——
   * 这一格只是文字,不注册任何按键。
   */
  shortcut?: string
  /** false = 点了菜单不收(在原浮层里换一屏,如「选择文字」);默认点了就收。 */
  closeOnClick?: boolean
  onClick?: () => void
  children: ReactNode
}

export function MenuItem({ icon, danger, disabled, title, className, style, 'data-testid': testId, render, nativeButton, shortcut, closeOnClick, onClick, children }: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn('group/menu-item', menuItem, className)}
      style={{ padding: menuRowPadding, ...style }}
      data-variant={danger ? 'danger' : 'default'}
      data-testid={testId}
      disabled={disabled}
      title={title}
      render={render}
      nativeButton={nativeButton}
      closeOnClick={closeOnClick}
      onClick={onClick}
    >
      {icon != null && <span className={menuItemIcon}>{icon}</span>}
      <span className={menuItemLabel}>{children}</span>
      {shortcut != null && (
        <span
          className="gg-menu-item-shortcut ms-6 shrink-0 text-[length:var(--font-caption)] text-[var(--menu-icon)]"
          aria-hidden="true"
        >
          {shortcut}
        </span>
      )}
    </MenuPrimitive.Item>
  )
}

/**
 * 分组线:把性质不同的动作隔开(例如「改名 / 复制地址」与「移除 / 卸载」这类不可轻易撤回的)。
 * 与会话页 dropdown-menu 的分隔线同一画法:贴满菜单宽度的一条细线。
 */
export function MenuSeparator({ className }: { className?: string }) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn('gg-menu-separator -mx-1 my-1 h-px bg-[var(--border)]', className)}
    />
  )
}

function DropdownMenuRoot({ onOpenChange, ...props }: MenuPrimitive.Root.Props) {
  // 同 Menu:开着时安卓返回键先关它。受控看 `open`,非受控跟 onOpenChange。
  const actions = useRef<MenuPrimitive.Root.Actions>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(props.defaultOpen))
  useBackLayer((props.open ?? uncontrolledOpen) ? () => actions.current?.close() : undefined)
  return (
    <MenuPrimitive.Root
      {...props}
      actionsRef={actions}
      onOpenChange={(open, details) => { setUncontrolledOpen(open); onOpenChange?.(open, details) }}
    />
  )
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger {...props} />
}

type DropdownMenuContentProps = Omit<MenuPrimitive.Popup.Props, 'className' | 'style'> & {
  className?: string
  style?: CSSProperties
  side?: MenuPrimitive.Positioner.Props['side']
  align?: MenuPrimitive.Positioner.Props['align']
  sideOffset?: number
  alignOffset?: number
  zIndex?: number | string
}

function DropdownMenuContent({
  className,
  style,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  alignOffset = 0,
  zIndex = 'var(--z-menu)',
  ...props
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="gg-menu-positioner window-no-drag-region"
        positionMethod="fixed"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={8}
        style={{ zIndex }}
      >
        <MenuPrimitive.Popup
          className={cn(menuPopup, className)}
          style={{ padding: menuSurfacePadding, ...style }}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** Trigger-anchored menu composition for account/actions dropdowns. */
export const DropdownMenu = {
  Root: DropdownMenuRoot,
  Trigger: DropdownMenuTrigger,
  Content: DropdownMenuContent,
  Item: MenuPrimitive.Item,
  /** 单选的一组(模式按钮 #7167):行照样用 `menuRowClassName`,选中那行由 `data-checked` 着色。 */
  RadioGroup: MenuPrimitive.RadioGroup,
  RadioItem: MenuPrimitive.RadioItem,
}
