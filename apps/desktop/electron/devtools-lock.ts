import { app, type MenuItemConstructorOptions, type WebContents, type WebPreferences } from 'electron'

/**
 * @@@devtools-lock — 正式版装机包关掉「重载 / 开发者工具」这一整类入口。
 *
 * 动机(owner 2026-09-06):普通用户不该能对着产品按 Cmd+R 或直接开 DevTools 去扒实现;
 * 误按 Cmd+R 把正在跑的会话整窗重载,本身也是个真实的产品事故面。
 *
 * 锁谁:**只有正式版(production tier)装机包锁**,其余 tier 默认不锁。这把锁同时管重载与
 * DevTools(下面四层一起开关),所以非正式版上 Cmd/Ctrl+R 重载也一并放开。
 *
 * ⚠️ 边界要说清楚,免得后来人把它当护身符:**这不等于防破解**。asar 是关掉的
 * (electron-builder.cjs @@@kill-asar),整棵 app 就是明文 JS 躺在安装目录里;而
 * ELECTRON_RUN_AS_NODE 在本产品里是承重的(engine-downloader 靠它跑随包的 npm、
 * claude/codex ACP 靠它当 node 兜底),所以 @electron/fuses 的 runAsNode 也关不掉。
 * 拿到装机包的人终究读得到代码 —— 真防线在服务端。本模块只做一件事:把「顺手就能打开」
 * 的调试面关掉。
 *
 * 四层各自独立,任何一层单独存在都能被绕开:
 *   ① webPreferences.devTools:false —— Electron 层面就不给开(含 <webview> 客体)。
 *   ② 自建应用菜单 —— 默认菜单的 View 自带 reload / forceReload / toggleDevTools 三个 role,
 *      连带 Cmd+R、Cmd+Shift+R、Cmd+Alt+I 的加速键;整条 View 换成只剩缩放与全屏。
 *      ❌ 不能图省事 setApplicationMenu(null):macOS 上 Cmd+C/V/X/A/Q/W/M 全靠应用菜单的
 *      role 提供,清掉菜单 = 复制粘贴和退出一起没了。
 *   ③ before-input-event —— 菜单管不到的键盘路径(F5 / F12 / Ctrl+Shift+I …)在按键层吃掉。
 *   ④ devtools-opened —— 万一还有没堵上的路径开出来了,立刻关掉并留一行日志(fail loud,
 *      不静默:出现这行就说明前三层漏了,是要查的 bug 不是正常态)。
 */

/** vite define 在 electron 主进程包里把它换成字面量;单测里没有这个 define,用 typeof 兜住。 */
declare const __GUGU_TIER__: string | undefined
const BUILD_TIER: string = typeof __GUGU_TIER__ === 'string' ? __GUGU_TIER__ : 'production'

export type DevtoolsLockInputs = {
  /** app.isPackaged —— 只有装机包才锁,开发跑 vite dev server 时一切照旧。 */
  isPackaged: boolean
  /** 构建期烤进包里的 tier(__GUGU_TIER__),❌ 不读 process.env.GUGU_TIER:那个用户改得动。 */
  tier: string
  env: NodeJS.ProcessEnv
}

/**
 * 生产包硬锁,没有任何环境变量能解开 —— 解锁开关如果生产也认,那就等于没锁。
 * 非生产 tier(beta / acceptance-*)默认不锁;想让 dogfood 包和正式版表现一致时,显式设
 * GUGU_DEVTOOLS=0 锁上。GUGU_DEBUG_PORT(YATU)优先于这个关闭开关:那条路本来就开着 CDP,
 * 再锁 DevTools 只是自欺。
 */
export function resolveDevtoolsLocked({ isPackaged, tier, env }: DevtoolsLockInputs): boolean {
  if (!isPackaged) return false
  if (tier === 'production') return true
  if (env.GUGU_DEBUG_PORT) return false
  return env.GUGU_DEVTOOLS === '0'
}

let cached: boolean | null = null

/** 本次进程是否处于锁定态。算一次就钉住:同一个进程里答案不该随环境变量被改而变。 */
export function isDevtoolsLocked(): boolean {
  if (cached === null) {
    cached = resolveDevtoolsLocked({ isPackaged: app.isPackaged, tier: BUILD_TIER, env: process.env })
  }
  return cached
}

/**
 * 给任何 BrowserWindow / <webview> 的 webPreferences 盖上锁。返回同一个对象,方便内联进
 * `new BrowserWindow({ webPreferences: hardenWebPreferences({ ... }) })`。
 */
export function hardenWebPreferences<T extends WebPreferences>(prefs: T): T {
  if (isDevtoolsLocked()) prefs.devTools = false
  return prefs
}

type KeyInput = {
  type: string
  key: string
  code?: string
  control?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

/**
 * 判一次按键是不是「重载 / 开发者工具」类。纯函数,单测直接喂输入。
 *
 * key 跟键盘布局走(Dvorak 上按 KeyR 打出来不是 r),code 是物理键位 —— 两个都看,
 * 免得换个布局就漏。❌ 别只看 key。
 *
 * ⚠️ **这张表的每一条都是纯支出**:preventDefault 会连页面的 keydown 一起吃掉(Electron
 * 文档明写),而会话页里有一个真终端(xterm),页面收不到的键 = 终端里的程序也收不到。
 * 所以只收「本平台真的会触发重载 / DevTools」的那一个组合,收多一个都是白赔功能。
 * 实测(Electron 44 真机读回默认应用菜单,2026-09-06):默认菜单只绑了
 * `CmdOrCtrl+R`(reload)、`Shift+CmdOrCtrl+R`(forceReload)、mac 的 `Alt+Command+I`
 * / 其他平台的 `Ctrl+Shift+I`(toggleDevTools);**F5 / F12 / F11 一个都没绑**。
 *
 * 已核过的三处「不能收」:
 *   • **F5 / F12**:默认菜单根本没绑(见上),拦了零收益;而终端里的 TUI(vim / htop / mc)
 *     全靠功能键。
 *   • **Ctrl+Shift+C / Cmd+Shift+C**:会话页终端的复制(终端里 Ctrl+C 是 SIGINT),所以
 *     整个 C 键不收。Chromium 的 inspect-element 走这个键位,但 devTools:false 那层已经
 *     把它变成死键。
 *   • **macOS 上的 Ctrl+R**:那是 bash/zsh 的反向历史搜索,mac 的重载键是 Cmd+R,两者
 *     必须分开 —— 所以 R 只按**本平台的重载修饰键**判,❌ 别用「Cmd 或 Ctrl」一把抓。
 *
 * 明知的取舍:mac 上的 Cmd+R 会让 github-device-flow-modal 里「重开授权页」那个快捷键失效。
 * 今天按下去是整窗重载、OAuth 直接中断,比快捷键不响应更糟。
 */
export function isReloadOrDevtoolsChord(input: KeyInput, platform: NodeJS.Platform = process.platform): boolean {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
  const key = (input.key ?? '').toLowerCase()
  const code = input.code ?? ''
  const isMac = platform === 'darwin'
  // 本平台的「重载」修饰键:mac 是 Command,其余是 Control。
  const reloadModifier = isMac ? Boolean(input.meta) : Boolean(input.control)

  // 重载与强制重载(Shift 变体同一个修饰键)。
  if (reloadModifier && (key === 'r' || code === 'KeyR')) return true

  // DevTools:mac 是 Cmd+Alt+I/J,Windows/Linux 是 Ctrl+Shift+I/J。
  const inspectKey = key === 'i' || key === 'j' || code === 'KeyI' || code === 'KeyJ'
  if (!inspectKey) return false
  return isMac ? Boolean(input.meta && input.alt) : Boolean(input.control && input.shift)
}

/**
 * 锁定态的应用菜单模板。**逐项对齐 Electron 的默认菜单,只换掉 View 那一条** —— 默认菜单里
 * 有什么,这里就得有什么,少一个就是白丢一个用户天天在按的快捷键。
 *
 * ⚠️ 这里踩过一次:第一版把 fileMenu 写成「只有非 mac 才加」,结果 macOS 上
 * **Cmd+W(关闭窗口)整个没了** —— 咕咕的关窗是「收进托盘」,等于把收起 app 的键盘入口删了。
 * 实测读回 Electron 44 的默认菜单(2026-09-06)才发现:mac 的默认菜单是 appMenu **加**
 * fileMenu,不是二选一。改这个模板前先跑一次默认菜单读回对照,❌ 别照记忆写。
 *
 * View 用 role:'viewMenu' 保留本地化好的「视图 / View」标题,submenu 换成自己的,
 * 于是 reload / forceReload / toggleDevTools 连同它们的加速键一起消失。
 */
export function lockedMenuTemplate(
  platform: NodeJS.Platform,
  appMenu: MenuItemConstructorOptions = { role: 'appMenu' },
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  return [
    ...(isMac ? [appMenu] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}

function guardWebContents(contents: WebContents, onBreach: (url: string) => void): void {
  contents.on('before-input-event', (event, input) => {
    if (isReloadOrDevtoolsChord(input as unknown as KeyInput)) event.preventDefault()
  })
  // <webview> 客体的 webPreferences 由宿主在这里定;devTools 也要一起关。
  contents.on('will-attach-webview', (_event, webPreferences) => {
    hardenWebPreferences(webPreferences as WebPreferences)
  })
  contents.on('devtools-opened', () => {
    onBreach(contents.getURL())
    contents.closeDevTools()
  })
}

let installed = false

/**
 * 装上按键与 DevTools 守卫,返回是否真的锁了。幂等,且**必须在第一个窗口创建之前**调 ——
 * 'web-contents-created' 要先于主窗口注册,否则主窗口自己就漏在外面。所以它挂在 main.ts 的
 * 模块顶层,不等 whenReady。
 */
export function installDevtoolsLock(onBreach: (url: string) => void): boolean {
  if (!isDevtoolsLocked()) return false
  if (installed) return true
  installed = true
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, onBreach))
  return true
}
