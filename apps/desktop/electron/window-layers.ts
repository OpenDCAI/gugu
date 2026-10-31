import { WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents, type WebPreferences } from 'electron'
import { hardenWebPreferences } from './devtools-lock'

/**
 * #77 浮在网页之上的那几块(agent 的鼠标、快捷消息、构建角标)是咕咕窗口里叠在最上面的几层 view,❌ 另开子窗。
 *
 * 子窗要露出来只有 show / showInactive,macOS 上那会把咕咕连同子窗提到别的 App 前面(electron#49393;mac1 实测:
 * 别的 App 的窗盖着咕咕时,showInactive 一扇子窗,咕咕就跑到它上面)。不那样露、只 moveAbove 摆上去,又挂不上原生父子关系,
 * 窗口一被点到前面子窗就沉到下面(#77)。窗口里的层和窗口是一体的:窗口看得见它就看得见(分屏也一样),不多一扇窗、
 * 不动窗口的层级、露出来不拿焦点(mac1 实测)。
 *
 * 代价是点不穿:层盖着的那块,人的点击落在层上。所以快捷消息、角标的层只有它们自己那么大;铺满网页的那层(agent 的鼠标)
 * 只在 agent 操作时露出。层只接点击、不留键盘焦点:被点到时焦点当场交回窗口界面(或用它的人指定的那份内容)——
 * 层是另一份内容,界面的按键处理收不到它里面的按键,留在层里就成了打字没反应、快捷键失灵。
 *
 * 层是界面开出来、界面画的:界面整页重载、渲染进程没了、窗口关了,这扇窗的层一并关掉 —— ❌ 留着上一页画的东西
 * (铺满网页的那层还会一直挡着点击)。
 *
 * 界面照旧 `window.open('about:blank', 名字)` 开一份同源空白页、直接画进去(同一个渲染进程,createPortal);
 * 主进程在 setWindowOpenHandler 的 createWindow 里把这份内容装进一层。网页 view 后挂上去会压在层上 ⇒ 挂网页的地方
 * 随后调 raiseWindowLayers。
 *
 * ⚠️ 界面 ❌ 对层调 `window.close()`:Electron 的 window.close 是「关掉这份内容所在的那扇窗」(rpc-server.ts
 * BROWSER_WINDOW_CLOSE → getOwnerBrowserWindow().close()),层的那扇窗就是咕咕窗口本身 —— 会把整扇窗关掉(mac1 实测)。
 * 层由主进程关(webContents.close()):同一个名字再开一层时换掉旧的,用它的那边不要了时请主进程关。
 */

/** window.open 交过来的那份新内容,和 Electron 为它算好的网页设置。 */
export type WindowLayerContent = { webContents: WebContents; webPreferences?: WebPreferences }

/** 层之间谁在上:数大的在上。 */
export const WINDOW_LAYER_RANK = { agentCursor: 0, agentBadge: 1, buildTag: 2 } as const

type Layer = { view: WebContentsView; rank: number }

const layersByHost = new WeakMap<BrowserWindow, Layer[]>()
const hostsWired = new WeakSet<BrowserWindow>()

/** 装进层里的那份内容:和主窗同进程(sandbox 要一样,否则分进程、window.open 拿到 null),界面全由主窗画进去。 */
export function windowLayerOptions(extra: { enablePreferredSizeMode?: boolean } = {}): BrowserWindowConstructorOptions {
  return {
    webPreferences: hardenWebPreferences({
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...extra,
    }),
  }
}

/**
 * `window.open` 开出来的那份内容装进这扇窗最上面的一层;先不露,由用它的人摆好位置再 setVisible。内容关了层就摘掉。
 * 网页设置要原样带上:WebContentsView 接手一份现成内容时,会拿构造参数里的 webPreferences 整个覆盖它原来的
 * (electron_api_web_contents.cc CreateFromWebPreferences → SetFromDictionary),不带就成了默认值(preferred size 关了)。
 */
export function openWindowLayer(
  host: BrowserWindow,
  content: WindowLayerContent,
  rank: number,
  options: {
    /** 层被点到时键盘焦点交给谁(没有就交回窗口界面)。 */
    focusTarget?: () => WebContents | null
  } = {},
): WebContentsView {
  const { webContents } = content
  const view = new WebContentsView({ webContents, webPreferences: content.webPreferences })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  wireHost(host)
  webContents.on('focus', () => {
    if (host.isDestroyed()) return
    const target = options.focusTarget?.() ?? host.webContents
    if (target !== webContents && !target.isDestroyed()) target.focus()
  })
  let layers = layersByHost.get(host)
  if (!layers) {
    layers = []
    layersByHost.set(host, layers)
  }
  layers.push({ view, rank })
  layers.sort((a, b) => a.rank - b.rank)
  host.contentView.addChildView(view)
  raiseWindowLayers(host)
  const owned = layers
  webContents.once('destroyed', () => {
    const at = owned.findIndex((layer) => layer.view === view)
    if (at !== -1) owned.splice(at, 1)
    if (!host.isDestroyed()) host.contentView.removeChildView(view)
  })
  return view
}

function wireHost(host: BrowserWindow): void {
  if (hostsWired.has(host)) return
  hostsWired.add(host)
  const closeAll = () => {
    for (const { view } of [...(layersByHost.get(host) ?? [])]) {
      const contents = view.webContents
      if (contents && !contents.isDestroyed()) contents.close()
    }
  }
  host.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) closeAll()
  })
  host.webContents.on('render-process-gone', closeAll)
  host.once('closed', closeAll)
}

/** 往窗口上挂了网页之后:把层重新叠回最上面(再挂一次就到最上层,按 rank 从下往上)。 */
export function raiseWindowLayers(host: BrowserWindow): void {
  if (host.isDestroyed()) return
  for (const { view } of layersByHost.get(host) ?? []) host.contentView.addChildView(view)
}

/**
 * 谁来接哪种名字的层:agent 浮层归会话页主进程那边(browser-page-views.ts)。它是另一个入口、启动后才加载,
 * 宿主这边不直接引它 ⇒ 那边加载时在这里登记,宿主的 window.open 处理按名字来问。
 */
export type WindowLayerServer = {
  /** 认不认这个名字。 */
  accepts: (frameName: string) => boolean
  /** 这份内容的网页设置(window.open 放行时一并给出)。 */
  options: (frameName: string) => BrowserWindowConstructorOptions
  /** 装进 host 的层、交给这边摆。 */
  open: (host: BrowserWindow, frameName: string, content: WindowLayerContent) => void
}

const servers = new Map<string, WindowLayerServer>()

/** 登记(同一个 id 再登记就换成新的)。 */
export function serveWindowLayers(id: string, server: WindowLayerServer): void {
  servers.set(id, server)
}

/** 这个 window.open 要开的是一层:给出放行的回答(内容装进 host 的层,❌ 新开窗口);不是就 null。 */
export function windowLayerResponse(host: BrowserWindow, url: string, frameName: string) {
  if (url !== 'about:blank' && url !== '') return null
  const server = [...servers.values()].find((entry) => entry.accepts(frameName))
  if (!server) return null
  return {
    action: 'allow' as const,
    overrideBrowserWindowOptions: server.options(frameName),
    createWindow: (options: BrowserWindowConstructorOptions): WebContents => {
      // Electron 把这份新内容放在 options.webContents 里交过来(guest-window-manager),装进层后原样交回。
      const webContents = (options as { webContents?: WebContents }).webContents
      if (!webContents) throw new Error(`window.open for a window layer came without its web contents: ${frameName}`)
      server.open(host, frameName, { webContents, webPreferences: options.webPreferences })
      return webContents
    },
  }
}
