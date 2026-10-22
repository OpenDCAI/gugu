import { app, type BrowserWindow } from 'electron'

/**
 * #77 在父窗上面露出一扇不抢焦点的小子窗(agent 浮层、构建角标)。只用标准做法:`showInactive` 挂成真正的原生子窗,
 * 父窗被提前、移动、最小化时都跟着它。
 *
 * macOS 的 `showInactive` 会把整个 App 提到别的 App 前面(orderFrontRegardless;electron#49393,至今没有不提前的接口)。
 * ⇒ macOS 上只在父窗就是前台窗口(人正看着咕咕)时露出;不是就等人回到这扇窗再露,露之前再问一次还要不要。
 * ❌ `moveAbove` 顶替:它不挂原生父子关系(Electron 44 只给 show / showInactive 过的子窗挂),父窗一被提前它就沉下去,
 *   而 isVisible / getParentWindow 照旧,没人会再把它抬上来(mac1 实测)。
 */
const waiting = new Map<BrowserWindow, () => void>()

export function showChildAbove(child: BrowserWindow, parent: BrowserWindow, wanted: () => boolean): void {
  if (process.platform !== 'darwin') {
    child.showInactive()
    return
  }
  if (parent.isFocused()) {
    waiting.get(child)?.()
    child.setParentWindow(parent)
    child.showInactive()
    return
  }
  if (waiting.has(child)) return
  const stop = () => {
    parent.removeListener('focus', check)
    app.removeListener('did-become-active', check)
    child.removeListener('closed', stop)
    waiting.delete(child)
  }
  function check() {
    if (child.isDestroyed() || parent.isDestroyed()) return stop()
    if (!parent.isFocused()) return
    stop()
    if (!wanted() || child.isVisible()) return
    child.setParentWindow(parent)
    child.showInactive()
  }
  parent.on('focus', check)
  app.on('did-become-active', check)
  child.once('closed', stop)
  waiting.set(child, stop)
}

/** 收起(不再等着露出)。最小化时子窗跟着父窗收走但仍记着「要显示」,还原时会自己冒出来 ⇒ 不管看不看得见都 hide 一次。 */
export function hideChild(child: BrowserWindow): void {
  waiting.get(child)?.()
  if (!child.isDestroyed()) child.hide()
}
