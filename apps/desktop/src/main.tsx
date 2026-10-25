// @@@2314/#2382 错误捕获必须是**第一个** import:ES 模块先把整张导入图求值完才执行本文件的函数体,
// 所以写成函数调用永远晚于 `import App` 那条链 —— 而"启动期模块求值就抛"(白屏)正是最要命、最该留证据的
import { detectHostOs } from '@shared/host-os'
// 那一类失败。这个模块 import 即装钩。❌ 别把它挪到下面,也别改成函数调用。
import './lib/errorCaptureBootstrap'
// 网页形态按 http://<ip> 直开时浏览器不给 crypto.randomUUID,全仓裸用 → 会话页启动即白;import 即装垫片。
import './lib/insecure-context-shims'
import React from 'react'
import App from './App'
import { renderEntryRoot } from './lib/renderer-entry-root'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { captureReferralFromUrl } from './lib/referral'
import { installScrollbarAutoHide } from './lib/scrollbarAutoHide'
import { installWindowMaterialAttribute } from './lib/windowMaterial'
import {
  hasWindowTitlebarRow,
  rendererPlatformFor,
  titlebarActionsLane,
  windowControlsWidth,
  windowTitlebarHeight,
} from './lib/window-chrome'
import { getLocaleSnapshot, LocalizationProvider, subscribeLocale } from './i18n'
import { platform } from './platform'
import { installPlatformLocaleSync } from './platform/locale-sync'
import { startShellChromeTone } from './platform/capacitorShellChrome'
import { BuildTagBadge } from './components/BuildTagBadge'
import { startFirstRunApps } from './components/appSlot/firstRunApps'
import './i18n/registerMainCatalog'
import './i18n/registerSettingsCatalog'
import './i18n/registerMessagingCatalog'
import './i18n/registerContactsCatalog'
import './i18n/registerAgentsCatalog'
import './i18n/registerAssistantCatalog'
import './styles/sora.css'
import './styles/tokens.css'
import '@gugu/session-shared/animation-visibility.css'
import { installPerfCounterResponder } from './lib/perfCounterResponder'

installPerfCounterResponder(window.electronAPI)

installPlatformLocaleSync(platform, {
  getSnapshot: getLocaleSnapshot,
  subscribe: subscribeLocale,
})

// 首启默认组(owner 10-16「为什么会有安装这一步,而不是一启动就装好了」):一启动就开始,和登录并行 —— 桌面听 main 装到哪了,
// 手机在这一页里自己装(firstRunApps.ts)。
startFirstRunApps()

// @@@scrollbar-autohide (#7641) 滚动条平时透明、滚动时浮出 —— 这里只负责在滚动的元素上打
// `data-scrolling`,显隐规则在 styles/tokens.css。装在这里而不是某个组件的 effect 里:
// 它是一条进程级的 DOM 监听,与任何一棵 React 子树的生死无关。
installScrollbarAutoHide()

// @@@1511 启动即捕获邀请链接 ?ref=<gugu_number>,暂存待注册时塞进 signup metadata(给双方发返利积分)。
captureReferralFromUrl()

// @@@1238-platform-attr / @@@822 — surface the OS to CSS so the frameless title bar can reserve the
// right window-control inset only where it actually draws controls. Mac keeps native traffic lights
// (titleBarStyle:hiddenInset) reserved left via --titlebar-traffic-lights-width; Windows/Linux are
// frameless (frame:false) and self-draw min/max/close on the right (--titlebar-controls-width). Only
// the desktop renderer has either — the web build stays 'other' (no phantom inset); see rendererPlatformFor.
// @@@host-os 系统探针只有 `@shared/host-os` 一条;这里把它收窄成「画什么窗口外壳」。
const rendererPlatform = rendererPlatformFor(detectHostOs(), window.desktopWindow)
document.documentElement.dataset.platform = rendererPlatform
document.documentElement.style.setProperty(
  '--titlebar-controls-width',
  `${windowControlsWidth(rendererPlatform)}px`,
)
// Windows 的窗口按钮在独立的标题栏行里(WindowTitleBar)。CSS 只认这个属性,❌ 不再按平台名自己判一遍。
if (hasWindowTitlebarRow(rendererPlatform)) document.documentElement.dataset.windowTitlebar = 'row'
document.documentElement.style.setProperty('--window-titlebar-height', `${windowTitlebarHeight(rendererPlatform)}px`)
document.documentElement.style.setProperty('--titlebar-actions-lane', `${titlebarActionsLane(rendererPlatform)}px`)
// @@@window-material (#7333) — 系统材质透不透,由主进程读系统信号判定;这里只落属性(CSS 只认它)。
installWindowMaterialAttribute(document.documentElement, window.desktopWindow)

// @@@window-tone — 开机也同步一次。运行期改主题由 `host-theme.ts` 的 applyEffectiveTheme 负责,
// 但**开机那一次**属性是 index.html 的引导脚本直接落的,不经过它 —— 不补这一下,
// 一个装完就选深色、之后再没切过的用户,主进程会一直按记住的浅色开窗。
// 读属性而不是读偏好:属性就是真值(引导脚本已经把 `system` 解析完了)。
window.electronAPI?.syncWindowTone?.(
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
)
// 安卓壳的系统栏同理(@@@mobile-shell-chrome),开机一次、之后跟属性走。
startShellChromeTone()

// ❌ 别改回 `ReactDOM.createRoot(...)`:热更新会重新执行本模块,那样会在同一个 `#root` 上
// 建出第二棵 React 树(React 只 console.error 一句,然后照样建)。为什么这会把开发环境搞死、
// 以及为什么解法是复用而不是跳过,见 `lib/renderer-entry-root.ts` 的抬头。
renderEntryRoot(
  'desktop',
  document.getElementById('root') as HTMLElement,
  <React.StrictMode>
    <>
      <AppErrorBoundary>
        <LocalizationProvider>
          <App />
          <BuildTagBadge />
        </LocalizationProvider>
      </AppErrorBoundary>
    </>
  </React.StrictMode>
)
