import type { BrowserWindow } from 'electron'

/**
 * #77 在父窗上面露出一扇不抢焦点的小子窗(agent 浮层、构建角标),并挂成真正的原生子窗:父窗被提到前面时它仍在上面。
 *
 * macOS 上两条路各有一个坑:
 * - `showInactive` 是 orderFrontRegardless:父窗不在前台时,会连父窗一起提到别的 App 前面(electron#49393)。
 * - `moveAbove` + `setParentWindow` 不提父窗,但 Electron 44 只给 show / showInactive 过的子窗挂原生父子关系,
 *   它只是此刻排在父窗上面;父窗一被提前(人点它、网页拿焦点),它就沉到父窗下面,而 isVisible / getParentWindow
 *   照旧,没人会再把它抬上来(mac1 实测)。
 * ⇒ 父窗此刻有焦点(就在前台):直接 showInactive,不会把谁提到别的 App 前面。没有焦点:先 moveAbove 露出来,
 *   等父窗拿到焦点那一刻再 showInactive 挂上。
 */
const attachOnParentFocus = new WeakSet<BrowserWindow>()

export function showChildAbove(child: BrowserWindow, parent: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    child.showInactive()
    return
  }
  if (parent.isFocused()) {
    child.setParentWindow(parent)
    child.showInactive()
  } else {
    child.moveAbove(parent.getMediaSourceId())
    child.setParentWindow(parent)
  }
  if (attachOnParentFocus.has(child)) return
  attachOnParentFocus.add(child)
  const attach = () => {
    if (!child.isDestroyed() && child.isVisible()) child.showInactive()
  }
  parent.on('focus', attach)
  child.once('closed', () => parent.removeListener('focus', attach))
}
