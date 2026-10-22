import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import { BUILD_TAG_WINDOW_NAME, isAgentOverlayWindowRequest, isAuxWindowRequest, isBuildTagWindowName } from '@shared/aux-window'
import { TRAFFIC_LIGHT_POSITION } from '@shared/window-chrome-native'
import { hardenWebPreferences } from './devtools-lock'
import { openBuildTagLayer } from './build-tag-window'
import { serveWindowLayers, windowLayerOptions, windowLayerResponse } from './window-layers'

/**
 * 咕咕的子窗口(一整块会话、一个 App 单独成窗,照 VS Code 的浮动编辑器窗口):渲染层 `window.open` 一扇同源空白窗,
 * 再把那块的界面直接画进去 —— 同一个渲染进程、同一份数据,❌ 不另起一个咕咕(那会多出一套同步与写库)。
 *
 * 所以这扇窗必须和主窗同进程:`sandbox:false` 要显式写(子窗默认沙盒,沙盒不同就分进程、`window.open` 拿到 null)。
 * 不给 preload:子窗里不跑任何自己的脚本,界面全由主窗那边画。外观:mac 同主窗(原生红绿灯压在页签条左端,页签条
 * 就是标题栏);Windows / Linux 用系统自己的标题栏 —— 主窗那三颗自绘按钮走的是「发消息的那扇窗」,从这边按会作用到
 * 主窗,不能照搬;系统标题栏在顶上一行,正是 Windows 应用的标准样子(主窗在 Windows 上也是顶上一行标题栏)。
 */
function auxWindowOptions(backgroundColor: string): BrowserWindowConstructorOptions {
  const isMac = process.platform === 'darwin'
  return {
    width: 1040,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    show: true,
    backgroundColor,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
    webPreferences: hardenWebPreferences({
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 会话里的浏览器页签、App 的页都是 <webview>。
      webviewTag: true,
      // 同主窗:后台的窗也要照常跑(终端、App 页)。
      backgroundThrottling: false,
    }),
  }
}

/**
 * 有自己外观与显隐的那几扇子窗(快速聊天小窗:quick-chat-window.ts):按名字认,外观用它自己的,建好交给它管。
 * 关它们的窗是「收起」,真关(主窗重载)用 destroy。
 */
export type SpecialAuxWindow = {
  name: string
  options: (backgroundColor: string) => BrowserWindowConstructorOptions
  adopt: (child: BrowserWindow) => void
}

/**
 * 主窗能换到的页面：应用自己的页面(同一协议、同一 host 和端口：重载、AgentJoinRoute 回首页)。❌ 比 origin:
 * `blob:gugu-app://app/…` 的源就是应用的源;主进程的 URL 对 gugu-app: 这种非特殊协议又只给 'null'。
 */
export function isOwnPage(target: string, current: string): boolean {
  try {
    const to = new URL(target)
    const at = new URL(current)
    return to.protocol === at.protocol && to.host === at.host
  } catch {
    return false
  }
}

/**
 * 主窗的 `window.open`:浮在网页上的那几层(构建角标、agent 的鼠标与小条)装进窗口里的层(window-layers.ts),
 * 咕咕子窗口放行(带上面的外观),其余一律交给系统浏览器(原来的行为)。
 * 主窗一重载 / 换页,子窗里画的东西就没了主人 —— 一并关掉,❌ 留一扇空白窗。
 */
export function attachAuxWindows(main: BrowserWindow, backgroundColor: () => string, special: readonly SpecialAuxWindow[] = []): void {
  const ownWindows = [...special]
  const children = new Set<BrowserWindow>()
  const specialChildren = new WeakSet<BrowserWindow>()
  serveWindowLayers(BUILD_TAG_WINDOW_NAME, {
    accepts: isBuildTagWindowName,
    options: () => windowLayerOptions({ enablePreferredSizeMode: true }),
    open: (host, _frameName, content) => openBuildTagLayer(host, content),
  })
  main.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const layer = windowLayerResponse(main, url, frameName)
    if (layer) return layer
    if (isAuxWindowRequest(url, frameName)) {
      const own = ownWindows.find((entry) => entry.name === frameName)
      return { action: 'allow', overrideBrowserWindowOptions: own ? own.options(backgroundColor()) : auxWindowOptions(backgroundColor()) }
    }
    // agent 浮层由会话页主进程那边接;它还没加载时 ❌ 把 about:blank 交给系统浏览器。
    if (isAgentOverlayWindowRequest(url, frameName)) return { action: 'deny' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 主窗自己也只在应用的页面里换页：拖进来的图(blob:,和应用同源;SVG 带着 image/svg+xml 时会在应用的源里跑脚本)、
  // 文件、没开新窗的链接，都换不了主帧;网页链接照样交给系统浏览器。写法同下面子窗那一句。
  main.webContents.on('will-navigate', (event, url) => {
    if (isOwnPage(url, main.webContents.getURL())) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  main.webContents.on('did-create-window', (child, { frameName }) => {
    if (!frameName || !isAuxWindowRequest('about:blank', frameName)) return
    children.add(child)
    child.on('closed', () => children.delete(child))
    const own = ownWindows.find((entry) => entry.name === frameName)
    if (own) {
      specialChildren.add(child)
      own.adopt(child)
    }
    // Windows / Linux 的应用菜单挂在每扇窗上:主窗无边框看不见它,子窗用系统标题栏,就在标题栏下面多出一排英文
    // 「File Edit View Window」(2026-10-10 win-dev 实拍)。这扇窗不要菜单(Electron 文档:win.removeMenu 去掉单扇窗的菜单);
    // 顺带去掉它的快捷键 —— 「重新加载」会把这扇窗换成空白页,画在里面的那块跟着没了。
    if (process.platform !== 'darwin') child.removeMenu()
    // 子窗里点到的外链同主窗:交给系统浏览器。挪进这扇窗的浏览器页签,agent 的鼠标 / 小条是这扇窗里的层。
    child.webContents.setWindowOpenHandler(({ url, frameName }) => {
      const layer = windowLayerResponse(child, url, frameName)
      if (layer) return layer
      if (isAgentOverlayWindowRequest(url, frameName)) return { action: 'deny' }
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    // 这扇窗只装主窗画进来的界面,自己哪也不去:往里拖进一个文件、点到一条没开新窗的链接,❌ 让它整扇换成那一页
    // (换了页,画在里面的那块就没了,窗也跟着关);网页链接照样交给系统浏览器。
    child.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
  })
  const closeAll = (): void => {
    for (const child of [...children]) if (!child.isDestroyed()) (specialChildren.has(child) ? child.destroy() : child.close())
  }
  main.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) closeAll()
  })
  main.on('closed', closeAll)
}
