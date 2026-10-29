/**
 * 任何时刻只有一行拥有浮窗(owner 报:划过气泡时偶尔同时出现两个)。每一行各开一个 PreviewCard,各自的关闭要等
 * Base UI 的 close delay(300ms),下一行 320ms 后就开了 ⇒ 换行时两个叠在一起;一行的「更多」开着(forceOpen)时再悬到
 * 别的行,第二个会一直在。⇒ 一个模块级的拥有者:接手的那一刻上一行立刻收起(浮窗随 visible 卸下,没有退场动画);
 * 菜单 / 表情面板开着时锁住,别的行接不走。没人接手的正常离开仍走 Base UI 的延迟与 safe polygon。
 */
export type HoverOwner = { id: symbol; locked: boolean } | null
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
/** 想拿浮窗:没人、或是自己、或上一位没锁 ⇒ 拿到。别人锁着(它的菜单开着)⇒ 拿不到。 */
export function claimHoverOwner(id: symbol, locked = false): boolean {
  if (hoverOwner && hoverOwner.id !== id && hoverOwner.locked) return false
  setHoverOwner(hoverOwner?.id === id && hoverOwner.locked === locked ? hoverOwner : { id, locked })
  return true
}
export function releaseHoverOwner(id: symbol): void {
  if (hoverOwner?.id === id) setHoverOwner(null)
}
