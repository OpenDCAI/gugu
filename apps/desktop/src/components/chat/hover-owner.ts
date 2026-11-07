/**
 * 任何时刻只有一行拥有浮窗(owner 报:划过气泡时偶尔同时出现两个)。每一行各开一个 PreviewCard,各自的关闭要等
 * Base UI 的 close delay(300ms);一行的「更多」开着(forceOpen)时再悬到
 * 别的行,第二个会一直在。⇒ 一个模块级的拥有者:接手的那一刻上一行立刻收起(浮窗随 visible 卸下,没有退场动画);
 * 菜单 / 表情面板开着时锁住,别的行接不走。没人接手的正常离开仍走 Base UI 的延迟与 safe polygon。
 */
export type HoverElements = { trigger: HTMLElement | null; popup: HTMLElement | null }
type HoverPoint = { x: number; y: number }
export type HoverOwner = { id: symbol; locked: boolean; elements?: HoverElements; point?: HoverPoint } | null
let hoverOwner: HoverOwner = null
const hoverOwnerListeners = new Set<() => void>()
export const readHoverOwner = (): HoverOwner => hoverOwner
export const subscribeHoverOwner = (listener: () => void) => {
  hoverOwnerListeners.add(listener)
  return () => { hoverOwnerListeners.delete(listener) }
}
export function setHoverOwner(next: HoverOwner): void {
  if (next === hoverOwner) return
  hoverOwner = next
  for (const listener of hoverOwnerListeners) listener()
}
/** The corridor narrows from the row edge to the popup's actual far edge, including flipped/shifted placements. */
function inHoverCorridor(point: HoverPoint, elements?: HoverElements, nextTrigger?: HTMLElement | null, origin?: HoverPoint): boolean {
  if (!elements?.trigger || !elements.popup) return false
  const row = elements.trigger.getBoundingClientRect()
  const popup = elements.popup.getBoundingClientRect()
  const next = nextTrigger?.getBoundingClientRect()
  if (next && point.x >= next.left && point.x <= next.right && point.y >= next.top && point.y <= next.bottom
    && (point.x < popup.left || point.x > popup.right)) {
    // A straight move into another bubble yields; a diagonal aimed into the popup still owns its travel corridor.
    const edge = point.x < popup.left ? popup.left : popup.right
    const dx = origin ? point.x - origin.x : 0
    const toward = (point.x < popup.left && dx > 0) || (point.x > popup.right && dx < 0)
    const crossingY = origin && toward ? origin.y + (edge - origin.x) * (point.y - origin.y) / dx : NaN
    if (!(crossingY >= popup.top && crossingY <= popup.bottom)) return false
  }
  const above = popup.top + popup.height / 2 < row.top + row.height / 2
  const from = above ? row.top : row.bottom
  const to = above ? popup.top : popup.bottom
  if (from === to || point.y < Math.min(from, to) || point.y > Math.max(from, to)) return false
  const progress = (point.y - from) / (to - from)
  const left = row.left + (popup.left - row.left) * progress
  const right = row.right + (popup.right - row.right) * progress
  return point.x >= left && point.x <= right
}

// @@@still-pointer - Where the mouse last moved. A row that scrolls under a still pointer is entered at exactly that spot; a pointer
// that moves onto a row enters at a new spot (Chromium sends the boundary events before that move's mousemove).
let lastMove: HoverPoint | undefined
if (typeof document !== 'undefined') document.addEventListener('mousemove', (event) => { lastMove = { x: event.clientX, y: event.clientY } }, true)
export const enteredByMoving = (event: MouseEvent): boolean => lastMove?.x !== event.clientX || lastMove?.y !== event.clientY

/** Keep menu locks and travel to the current popup; elsewhere, hand over without a delay. */
export function claimHoverOwner(id: symbol, locked = false, elements?: HoverElements, point?: HoverPoint): boolean {
  if (hoverOwner && hoverOwner.id !== id && (hoverOwner.locked || (!locked && point && inHoverCorridor(point, hoverOwner.elements, elements?.trigger, hoverOwner.point)))) return false
  setHoverOwner(hoverOwner?.id === id && hoverOwner.locked === locked ? hoverOwner : { id, locked, elements, point })
  return true
}
export function releaseHoverOwner(id: symbol): void {
  if (hoverOwner?.id === id) setHoverOwner(null)
}
