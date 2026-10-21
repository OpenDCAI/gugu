// 会话页(源码在 apps/desktop/src/session 与 packages/session-*)。它与咕咕**同一次 rollup**出产物(第二个入口 session-embedded.html),
// 这里把产出的 bundle 挂进一个 Shadow DOM——
// 同一文档、同一进程、同一 React 版本,CSS 靠 shadow root 隔离(会话页与 gugu 都用
// Tailwind v4 且都在 :root 定义 --text-*,同文档合并会互相污染,故 shadow 隔离)。
//
// 「原生融入」皮肤(owner 令:会话页要看起来本来就长在 gugu 里、UI 风格一致):
// 会话页的主题靠在挂载元素上打 emlight/emdark 类切换其 --neutral-*/--jade-* 原始色阶,
// 上层语义 token(--background/--foreground/--border 及 --em-* 设计系统)从中派生。我们
// 给挂载元素同时打 gugu-skin 标记 + 跟随 gugu 主题的 emlight/emdark,再在会话页自身
// CSS 之后注入一段桥接 <style>:把会话页的原始色阶/语义原色重定义为 gugu 的语义 token
// (--bg/--fg/--accent/--border-color… 经 host 继承进 shadow)。桥接规则不进 @layer、且
// 注入在后 → 稳压会话页的分层/在前规则。gugu 切明暗 → 挂载类翻转 → 会话页整体跟随。
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '@/platform'
import { i18n } from '@/i18n'
import { useTheme, type Theme } from '@/store/theme'
import { sessionSkinClassName } from './sessionSkin'
import { AlertCircle, RefreshCw } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import {
  createSessionHostWsClient,
  resolveSessionHostEndpoint,
  type SessionHostConnectionState,
  type SessionHostWsClient,
} from '@/lib/session-host-ws-client'
import { installSessionShellAuthHandoff } from '@/lib/session-shell-auth-handoff'
import { createWebSessionShellAnswers } from '@/lib/session-shell-web-answers'
import { answerSessionShellChannels, createSessionShellPort } from '@/session/shared/lib/ipc/shell-port'
import { findSessionHostBridge, SESSION_HOST_BRIDGE_KEY } from '@/session/renderer/lib/electron-api'
import { installSessionRendererBootFailureReporter } from '@/session/shared/lib/session-renderer-boot'
import { importSessionEntry } from './importSessionEntry'
import {
  parseEmdashManifest,
  requireEmdashManifestAssets,
  type EmdashManifestTransport,
} from './emdash-manifest'
import './EmdashSessionFrame.css'

// @@@single-rollup (#2802 片1) — 会话页入口现在与咕咕**同一次 rollup**产出,清单就是 dist 里与
// index.html 并排的 `emdash-embedded.html`,资产也在同一个 assets/ 下。此前它来自管线外的独立构建
// (`public/emdash/` → `dist/emdash/`),那条路径让开发机上「源码新、会话页 UI 旧」成为常态且静默
// (#2798);同生同灭之后这类漂移在结构上不再可能。
//
// **必须相对 document 解析**:绝对量 '/emdash-embedded.html' 在 file:// 下会打到文件系统根
// → fetch 失败、会话页整片白屏(#2220 打包/真机启动才暴露,dev 的 http origin 掩盖了它)。
// 用 document.baseURI 解析既覆盖 dev 的 http,也覆盖打包后的 file://。
const EMDASH_BASE_URL = new URL('.', document.baseURI)
const EMDASH_MANIFEST_URL = new URL('session-embedded.html', EMDASH_BASE_URL)

interface EmdashAssets {
  jsUrl: string
  /** null = Vite dev module graph owns style delivery; otherwise every built stylesheet has loaded (document order). */
  sheetsLoaded: Promise<void> | null
}

/**
 * 会话页的一张构建 CSS,以 `<link rel="stylesheet">` 挂进 document.head(@@@entry-css-as-link)。
 * ❌ 别回到「取下文本、注成 <style>」:vite 的预载助手判断一张 CSS 是否已在，只认 `link[href]`。注成 <style> 时它认不出，
 * 只要某个动态 import 的依赖清单里出现了入口那张表(比如 Monaco 的 editor.main 静态引了入口 chunk),它就再插一个 link ——
 * 477 KB 重新下载、重新解析、字体重新取(mac1 实测：第一次打开 diff 因此慢 40–50 ms)。用 link 挂，相对 url() 也按表自己的位置解析，
 * 不必再改写。
 */
function attachStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.setAttribute('data-sessionpage-css', '')
    link.onload = () => resolve()
    link.onerror = () => reject(new Error(`embedded stylesheet failed to load: ${href}`))
    document.head.appendChild(link)
  })
}

let emdashAssetsPromise: Promise<EmdashAssets> | null = null

async function loadEmdashAssets(): Promise<EmdashAssets> {
  const response = await fetch(EMDASH_MANIFEST_URL.href)
  if (!response.ok && response.status !== 0) {
    throw new Error(`embedded manifest request failed (${response.status})`)
  }
  const transport: EmdashManifestTransport = import.meta.env.DEV ? 'vite-dev' : 'built'
  const refs = requireEmdashManifestAssets(parseEmdashManifest(await response.text()), transport)
  const jsUrl = resolveEmdashAsset(refs.script)

  // Start download/parse of the renderer before the user reaches the task surface.
  if (!document.head.querySelector('link[data-emdash-module-preload]')) {
    const preload = document.createElement('link')
    preload.rel = 'modulepreload'
    preload.href = jsUrl
    preload.setAttribute('data-emdash-module-preload', '')
    document.head.appendChild(preload)
  }

  // Vite dev serves source HTML: CSS imports belong to the module graph and intentionally do not
  // appear as stylesheet links. Built HTML externalizes CSS, so the host attaches every listed sheet.
  if (transport === 'vite-dev') return { jsUrl, sheetsLoaded: null }

  // ⚠️ 全部 stylesheet,不是第一张 —— 张数由 vite 的 chunk 切分决定(见 emdash-manifest.ts)。
  // 挂的顺序 = 文档序 = 构建产出的层叠序,❌ 不能重排(后表覆盖前表)。预热时就挂上：会话页规则收窄在 .gugu-skin 下，早挂不伤咕咕。
  const sheetsLoaded = Promise.all(refs.stylesheets.map((href) => attachStylesheet(resolveEmdashAsset(href)))).then(() => undefined)
  return { jsUrl, sheetsLoaded }
}

function getEmdashAssets(): Promise<EmdashAssets> {
  emdashAssetsPromise ??= loadEmdashAssets()
  return emdashAssetsPromise
}

// MainLayout calls this only for the desktop shell. Keeping the warm-up out of module scope is
// important: mobile/Web imports still share the component graph, but must not fetch/parse the 14MB
// desktop task renderer just because the module was bundled.
// eslint-disable-next-line react-refresh/only-export-components -- the layout needs this explicit desktop-only prewarm hook.
export function prewarmEmdashAssets(): void {
  // 网页版:桥必须先于会话页任何模块装上(预热会把 bundle 拉进来求值)。桌面版此调用是空操作。
  installSessionHostBridge()
  void getEmdashAssets().catch(() => undefined)
}

// 会话页的两套 token 命名空间都由挂载元素上的 emlight/emdark 类驱动;此桥接把两套的
// 原始色阶 + 少量「原色型」语义 token 映射到 gugu 语义 token。规则设在 .gugu-skin(挂载
// 元素)上,经继承覆盖整棵会话页子树。❌ 引用 var(--border):会话页亦有同名 token
// (= var(--neutral-6))会撞名,故一律用 gugu 的 --border-color / --border-strong。
const GUGU_SKIN_BRIDGE_CSS = `
.gugu-skin {
  color-scheme: light dark;

  /* UNPREFIXED neutral ramp: 1 = app bg … 12 = primary text */
  --neutral-1: var(--bg);
  --neutral-2: var(--card);
  --neutral-3: var(--bg-elevated);
  --neutral-4: var(--muted);
  --neutral-5: color-mix(in srgb, var(--bg) 82%, var(--fg));
  --neutral-6: var(--border-color);
  --neutral-7: var(--border-strong);
  --neutral-8: color-mix(in srgb, var(--border-strong) 50%, var(--fg));
  --neutral-9: var(--faint-fg);
  --neutral-10: var(--faint-fg);
  --neutral-11: var(--muted-fg);
  --neutral-12: var(--text-primary);
  --neutral-contrast: var(--text-on-accent);

  /* explicit background/foreground/border steps (in case some are raw, not var(--neutral-n)) */
  --background: var(--bg);
  --background-1: var(--card);
  --background-2: var(--bg-elevated);
  --background-3: var(--muted);
  --foreground: var(--text-primary);
  --foreground-muted: var(--muted-fg);
  --foreground-passive: var(--faint-fg);
  --border-1: var(--border-strong);
  --border-primary: var(--faint-fg);

  /* accent / primary button = gugu mono accent (white on dark / black on light) */
  --primary-button-background: var(--accent);
  --primary-button-background-hover: var(--accent-hover);
  --primary-button-foreground: var(--text-on-accent);
  --primary-button-border: var(--accent);
  --ring: var(--accent);
  --selection: var(--text-selection);
  --selection-foreground: var(--text-primary);

  /* em neutral ramp (mirror of unprefixed) */
  --em-neutral-1: var(--bg);
  --em-neutral-2: var(--card);
  --em-neutral-3: var(--bg-elevated);
  --em-neutral-4: var(--muted);
  --em-neutral-5: color-mix(in srgb, var(--bg) 82%, var(--fg));
  --em-neutral-6: var(--border-color);
  --em-neutral-7: var(--border-strong);
  --em-neutral-8: color-mix(in srgb, var(--border-strong) 50%, var(--fg));
  --em-neutral-9: var(--faint-fg);
  --em-neutral-10: var(--faint-fg);
  --em-neutral-11: var(--muted-fg);
  --em-neutral-12: var(--text-primary);
  --em-neutral-contrast: var(--text-on-accent);

  /* em accent ramp = gugu mono accent */
  --em-accent-9: var(--accent);
  --em-accent-10: var(--accent-hover);
  --em-accent-11: var(--text-primary);
  --em-accent-12: var(--text-primary);
  --em-accent-contrast: var(--text-on-accent);

  /* em backgrounds */
  --em-background: var(--bg);
  --em-background-1: var(--card);
  --em-background-2: var(--bg-elevated);
  --em-background-3: var(--muted);
  --em-background-secondary: var(--sidebar);
  --em-background-tertiary: var(--bg-elevated);
  --em-background-quaternary: var(--bg);
  --em-background-neutral: var(--text-primary);
  --em-foreground-neutral: var(--bg);

  /* em foreground */
  --em-foreground: var(--text-primary);
  --em-foreground-inverse: var(--text-on-accent);
  --em-foreground-body: var(--text-primary);
  --em-foreground-muted: var(--muted-fg);
  --em-foreground-passive: var(--faint-fg);
  --em-foreground-secondary: var(--text-primary);
  --em-foreground-secondary-muted: var(--muted-fg);
  --em-foreground-secondary-passive: var(--faint-fg);
  --em-foreground-tertiary: var(--text-primary);
  --em-foreground-tertiary-muted: var(--muted-fg);
  --em-foreground-tertiary-passive: var(--faint-fg);

  /* em surface families ——每个面的 rest / hover / press / selected 四挡。
     @@@state-ladder-mix (#2322):hover/press/selected 一律用咕咕那条阶梯的实色配方
     (--state-tint + --state-*-amount,定义见 styles/tokens.css),对每个面 color-mix 出
     **与咕咕主体同深度**的实色。桥以前在这里自己拍 92%/85%(= 8%/15% 压色),比咕咕的
     2.4%/7.x% 深一倍到五倍 —— owner 2026-09-09 抱怨的「深浅不统一」就是这组数。
     ❌ 别在这里再拍百分比;要调阶梯去改 tokens.css 那一处,两边一起动才叫同源。 */
  --em-surface-sunken: var(--page);
  --em-surface-sunken-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--page));
  --em-surface-sunken-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--page));
  --em-surface-sunken-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--page));
  --em-surface-base: var(--bg);
  --em-surface-base-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--bg));
  --em-surface-base-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--bg));
  --em-surface-base-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--bg));
  --em-surface-base-emphasis: var(--card);
  --em-surface-base-emphasis-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--card));
  --em-surface-base-emphasis-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--card));
  --em-surface-base-emphasis-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--card));
  --em-surface-elevated: var(--card);
  --em-surface-elevated-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--card));
  --em-surface-elevated-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--card));
  --em-surface-elevated-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--card));
  --em-surface-elevated-emphasis: var(--bg-elevated);
  --em-surface-elevated-emphasis-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--bg-elevated));
  --em-surface-elevated-emphasis-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--bg-elevated));
  --em-surface-elevated-emphasis-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--bg-elevated));
  --em-surface: var(--bg);
  --em-surface-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--bg));
  --em-surface-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--bg));
  --em-surface-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--bg));
  --em-surface-emphasis: var(--card);
  --em-surface-emphasis-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--card));
  --em-surface-emphasis-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--card));
  --em-surface-emphasis-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--card));
  /* paper = 对话流那张「纸」。它的**静息色**故意不桥接(保留任务页自己的纸色,换它是另一件事),
     这里只把它的三个交互档拉回同一条阶梯 —— 状态深浅统一,表面色不动。 */
  --em-surface-paper-hover: color-mix(in srgb, var(--state-tint) var(--state-hover-amount), var(--em-surface-paper));
  --em-surface-paper-press: color-mix(in srgb, var(--state-tint) var(--state-press-amount), var(--em-surface-paper));
  --em-surface-paper-selected: color-mix(in srgb, var(--state-tint-selected) var(--state-selected-amount), var(--em-surface-paper));
  --em-surface-input: var(--input-bg);
  --em-surface-foreground: var(--text-primary);
  --em-surface-border: var(--border-color);

  /* em borders / selection */
  --em-border: var(--border-color);
  --em-border-1: var(--border-strong);
  --em-border-2: var(--border-strong);
  --em-border-primary: var(--faint-fg);
  --em-selection: var(--bg-accent-soft);
  --em-selection-foreground: var(--text-primary);

  /* em primary button = gugu accent */
  --em-primary-button-background: var(--accent);
  --em-primary-button-background-hover: var(--accent-hover);
  --em-primary-button-foreground: var(--text-on-accent);
  --em-primary-button-border: var(--accent);

  /* ── Typography → gugu 正文字体(#7333 起系统字体;下文说的 Sora 即这条正文栈) (#2220 后续:「缺乏精致感,没在一套设计语言上」) ─────────
     会话页的 --em-type-<role>-font-family 由 vanilla-extract codegen 生成为
     var(var(--em-font-sans)) —— 双层嵌套 var()。这不是合法 CSS(var() 的第一参数必须是裸
     自定义属性名,不能再是一个 var() 调用),在真实属性上使用时 computed-value-time 判定
     invalid;因为 font-family 是继承属性,浏览器退回「继承值」而非「初始值」——恰好等于
     html/body 上 font-family:var(--em-font-sans) 那条(单层、合法)。也就是说仅改
     --em-font-sans 大概率也能带到大多数文字,但不能全信这个「无效值退回继承」的隐性行为,
     故对每个 SANS 角色的 font-family 直接给字面量值,绕开那层坏引用。MONO 角色(code/
     inline-code)不动——会话页自定义 mono 栈(JetBrains Mono…)保持不变。 */
  --em-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif; /* #7333 与 tokens.css --font-family-system 同一条栈 */
  /* 会话页原本只在 :root 声明 --em-font-mono(shadow 树里 :root 不生效的同一个坑,见上),
     从没在 .emlight/.emdark 这类真能命中挂载元素的地方重声明过——意味着这条 mono 桥接前,
     var(--em-font-mono) 在 shadow 树内本就是 undefined,not 我们改坏的。显式重声明,保
     会话页原装 JetBrains Mono 栈,让下面「mono 区域正向兜底」那条规则真的有值可用。 */
  /* @@@terminal-cjk-cell (#5586) — JetBrains 仍是西文的脸,'Sarasa Mono SC' 只接中文:
     它带 size-adjust:120%,汉字正好是 JetBrains 西文的两倍宽(见 styles/sarasa-mono.css)。
     没有它,中文落到系统字体、宽度比 1.661,终端里一行排满就被裁掉行尾。
     ❌ 别把 Sarasa 提到 JetBrains 前面 —— 那会把西文的脸也换掉。 */
  --em-font-mono:
    'JetBrains Mono Variable', 'JetBrains Mono', 'Sarasa Mono SC', Menlo, Monaco, monospace;
  --em-type-body-font-family: var(--em-font-sans);
  --em-type-body-bold-font-family: var(--em-font-sans);
  --em-type-body-italic-font-family: var(--em-font-sans);
  --em-type-body-link-font-family: var(--em-font-sans);
  --em-type-code-lang-font-family: var(--em-font-sans);
  --em-type-h1-font-family: var(--em-font-sans);
  --em-type-h2-font-family: var(--em-font-sans);
  --em-type-h3-font-family: var(--em-font-sans);
  --em-type-mention-font-family: var(--em-font-sans);

  /* type scale → gugu 字阶(#7333:body 14/20、h3 16/24、h2 20/28、h1 24/32,字重钉死)。
     只改 role 级 var,不碰共享的 --em-text-*(那是一堆非 role 组件/工具类的字号来源,
     全局改动爆炸半径太大)。字重钉死同样是因为双层 var 坑,不能全信继承。 */
  --em-type-body-font-size: 14px;
  --em-type-body-font-weight: 400;
  --em-type-body-line-height: 20px;
  --em-type-body-bold-font-size: 14px;
  --em-type-body-bold-font-weight: 600;
  --em-type-body-bold-line-height: 20px;
  --em-type-body-italic-font-size: 14px;
  --em-type-body-italic-font-weight: 400;
  --em-type-body-italic-line-height: 20px;
  --em-type-body-link-font-size: 14px;
  --em-type-body-link-font-weight: 400;
  --em-type-body-link-line-height: 20px;
  --em-type-mention-font-size: 14px;
  --em-type-mention-font-weight: 600;
  --em-type-mention-line-height: 20px;
  --em-type-h3-font-size: 16px;
  --em-type-h3-font-weight: 600;
  --em-type-h3-line-height: 24px;
  --em-type-h2-font-size: 20px;
  --em-type-h2-font-weight: 600;
  --em-type-h2-line-height: 28px;
  --em-type-h1-font-size: 24px;
  --em-type-h1-font-weight: 600;
  --em-type-h1-line-height: 32px;

  /* @@@shape-table (Refs #6104) — 圆角这一族**整块删掉了**,这里只留这条说明。
     原来这 12 行是第七套刻度:它在 .gugu-skin 里把 --radius-lg 改成 12、--radius-xl 改成 16,
     于是同一个 var(--radius-xl) 在任务页里是 16px、在任务页外是 12px ——
     「谁是权威源」的空缺就长成这个样子。
     现在 8 档语义表只有一份(apps/desktop/src/styles/tokens.css),.gugu-skin 是 :root 的后代,
     直接继承,无需覆盖;--em-radius-* 由 packages/session-ui/src/theme/tokens.css.ts 直接写成
     同一张表的值。❌ 别把这一族加回来。 */
}

/* @@@shadow-lift (Refs #6104) — 浮层只有一档投影。这几条从前分别指向 --shadow-popover 与
   --shadow-modal(当时是两个不同的值),现在两个名字本来就都是 --shadow-lift 的别名,
   这里直接写那一档,少一跳。
   为什么用 data-slot 做选择器:popup 的投影写在 vanilla-extract 组件样式里,类名带 hash,
   而 data-slot 是组件渲染时真实打在 DOM 上的属性,稳定。 */
.gugu-skin [data-slot='popover-content'],
.gugu-skin [data-slot='combobox-content'],
.gugu-skin [data-slot='dropdown-menu-content'],
.gugu-skin [data-slot='dropdown-menu-sub-content'],
.gugu-skin [data-slot='dialog-content'] {
  box-shadow: var(--shadow-lift);
}

/* 兜底 + 实测必要(非仅"以防万一"):会话页用 Tailwind v4 preflight 的
   'html, :host { font-family: var(--default-font-family, ui-sans-serif…) }' 做基础字体
   ——它直接设在 shadow host 上、走继承落到 mount 的每个后代,我们从没碰过
   --default-font-family 这个变量。绝大多数组件(如 Home 的 ActionListItem)也没有任何
   font-* 工具类去引用 --em-font-sans/--em-type-*,所以只改那些变量文字并不会真的变
   Sora——实测验证:同一条规则不带 !important 时 computed font-family 仍是 preflight 的
   default 栈,加 !important 才真正切到 Sora(回归探针见
   e2e/agent/taskpage-emdash-skin-shots.spec.ts(#6270 已删) 的 "Home ... label font-family" 诊断)。
   :where() 保零特异度,!important 只用来稳赢 preflight。
   .gg-md 的后代排除:共享 markdown 排版自己定字体(正文继承这里的 Sora、代码行 mono、公式 KaTeX),
   被钉成 Sora 的是代码里的着色 span 和整棵 KaTeX 子树。 */
.gugu-skin :where(:not(code):not(pre):not(kbd):not(samp):not([class*='mono']):not(.monaco-editor):not(.monaco-editor *):not(.xterm):not(.xterm *):not([class*='devicon']):not([class*='codicon']):not([data-chat-root]):not([data-chat-root] *):not(.gg-md *)) {
  font-family: var(--em-font-sans) !important;
}
/* 图标字体排除(找茬 #8):会话页带 devicon(woff/ttf,element 级 font-family:'devicon')做技术/语言
   图标——若被上面 !important 钉成 Sora 会渲成豆腐块。排除 devicon/codicon 类,让会话页自带的图标
   字体声明生效(codicon 在 .monaco-editor 内已被排除)。icon = SVG(lucide 等)不受 font-family 影响。 */

/* 光排除还不够:排除只挡住"直接命中 mono 元素/子树"的那一条规则,但 Sora 仍会从
   MONACO/XTERM 容器的祖先(被上面那条规则改成 Sora)顺着继承流进 .xterm/.monaco-editor
   内部没有自己 font-family 声明的节点(实测验证:.xterm 根节点原本无显式声明,靠继承,
   排除后仍读到 Sora)。故这里对 mono 区域做一条正向兜底,显式钉回 --em-font-mono——
   真选择器(非 :where())给够特异度,不依赖 !important 同权重下的源序仲裁。 */
.gugu-skin code,
.gugu-skin pre,
.gugu-skin kbd,
.gugu-skin samp,
.gugu-skin [class*='mono'],
.gugu-skin .monaco-editor,
.gugu-skin .monaco-editor *,
.gugu-skin .xterm {
  font-family: var(--em-font-mono) !important;
}
/* @@@terminal-cjk-cell (#5586) — ⚠️ 这里**只钉 .xterm 根节点**,❌ 不带 .xterm 的子树。
   (注意:这段 CSS 活在一个模板字符串里,注释里 ❌ 不能出现反引号 —— 会把字符串提前截断,
   整个任务页白屏。2026-09-14 踩过一次。)
   带上子树会连 .xterm-rows 一起钉死,而 xterm 自己给那一层注入的 font-family 正是它
   **量格子时用的那一支**;被 !important 压掉之后,「量」和「画」就成了两套字体 ——
   量的是 options.fontFamily,画的是 --em-font-mono。owner 2026-09-13 圈的「消息列表遮罩」
   就是这么来的,而且它还让设置里的自定义终端字体**根本不生效**(改了只改量、没改画)。
   根节点这一条仍要留着:它挡的是 Sora 从祖先继承进终端(见上一条规则的说明)。 */

/* 任务页左栏背景 → gugu 的 --sidebar(比会话页默认的 background-tertiary 更贴 gugu 的
   深浅层次)。bg-background-tertiary 是 Tailwind 字面量工具类(非 hash 类名),且只有
   LeftSidebar 的根节点在用(已核实全仓唯一命中,含 /80 透明度变体走独立类名不受影响)。 */
.gugu-skin .bg-background-tertiary {
  background-color: var(--sidebar);
}

/* Home 入口的「卡片式」行(ActionListItem:rounded-lg + bg-background + p-4)以及仓库里
   同款「卡片行」惯用法(设置页各行、GitHub 连接卡等同一 rounded-lg+bg-background 组合)
   统一放大到 gugu 的卡片圆角 + 1px 描边,读出「卡片」而不是「按钮」的质感。 */
.gugu-skin .rounded-lg.bg-background {
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
}
.gugu-skin .rounded-lg.bg-background:hover {
  background-color: var(--hover);
}
`

// @@@task-web-host — 会话页宿主桥的安装。桌面版:preload 已把 electronAPI 注入 window,什么都不做;
// 网页版:造一个 WebSocket 客户端连无头宿主,挂到 window.__GUGU_TASK_HOST_BRIDGE__(❌ 不挂到
// electronAPI 那个名下:壳里多处拿它的真值判「是不是 Electron」)。必须在加载会话页 bundle 之前装好
// —— bundle 的 ipc.ts 在模块求值时就取桥。
let sessionHostClient: SessionHostWsClient | null = null
function installSessionHostBridge(): SessionHostWsClient | null {
  if (platform.kind === 'electron') return null
  if (!sessionHostClient) {
    sessionHostClient = createSessionHostWsClient(resolveSessionHostEndpoint(), {
      messages: {
        hostNotConnected: i18n.t('shell.taskFrame.hostNotConnected', { ns: 'main' }),
        hostConnectionLost: i18n.t('shell.taskFrame.hostConnectionLost', { ns: 'main' }),
        hostUnreachable: i18n.t('shell.taskFrame.hostUnreachable', { ns: 'main' }),
      },
    })
    // 壳通道(sessionpage:*)由本页面当场应答,其余交给宿主(#5012)。账号侧的活壳委托给宿主的 sessionpageIdentity.*,
    // 为此先把登录态交给宿主(装桥时 / 登录态变化 / 宿主重连各推一次)。
    const hostApi = sessionHostClient.api
    const hostInvoke = (channel: string, ...args: unknown[]) => hostApi.invoke(channel, ...args)
    ;(window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY] = {
      ...hostApi,
      invoke: answerSessionShellChannels(hostInvoke, createWebSessionShellAnswers(hostInvoke)),
    }
    const client = sessionHostClient
    installSessionShellAuthHandoff({
      hostInvoke,
      onHostOpen: (cb) => client.onStateChange((state) => { if (state === 'open') cb() }),
    })
    void sessionHostClient.connect().catch(() => undefined)
  }
  return sessionHostClient
}

function resolveEmdashAsset(ref: string): string {
  // embedded.html refs are like "./assets/embedded-xxxx.js" — resolve against the session-page base dir.
  // 返回完整 href（含 origin/scheme）→ http 与 file:// 两种加载方式都对（❌ 不能只返回 pathname，file:// 下会丢盘符路径）。
  return new URL(ref, EMDASH_BASE_URL).href
}


// @@@fail-loud(owner 拍板):会话页起不来(资产没有正确载入 / renderer bootstrap 失败)= 应用级顶级错误,
// 经 main 直接退出整个 App(错误框 + exit 1),❌ 半残运行。invoke 通道意外缺失时错误卡兜底显示(仍 fail loud)。
function reportFatalBootFailure(err: unknown): void {
  console.error('[sessionpage] 会话页挂载失败', err)
  // 桌面版:经壳口到 main 退出整个 App;网页版:壳就是本页面,应答为空操作,错误卡照常显示。
  const bridge = findSessionHostBridge()
  if (!bridge) return
  void createSessionShellPort((channel, ...args) => bridge.invoke(channel, ...args))
    .fatalBoot(err instanceof Error ? (err.stack ?? err.message) : String(err))
    .catch(() => undefined)
}

export function EmdashSessionFrame() {
  const { t } = useTranslation('main')
  const hostRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)
  // 保证挂载整段在一个组件实例上恰好跑一次(见下方 StrictMode 说明)。
  const startedRef = useRef(false)
  // 会话页渲染层是个大 bundle,首次冷加载要几秒~几十秒。加载期间显式 loading 态(❌ 白屏,像坏了),
  // 会话页真挂上内容(mount 有子节点)后隐藏。
  // 加载态只有那个加载动画,无墙钟兜底页(owner 拍板砍掉):会话页在 App 启动即常驻预热,
  // 正常路径用户到达时已就绪;错误卡只留给真起不来(资源加载失败 / renderer bootstrap 失败,fail loud),不给「慢」。
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  // 网页版:无头宿主的连接状态;桌面版恒为 null(桥在 preload 里,没有"连接"这回事)。
  const [hostState, setHostState] = useState<SessionHostConnectionState | null>(null)
  const [hostEndpoint, setHostEndpoint] = useState<string | null>(null)
  const { theme } = useTheme()
  // 挂载是异步创建的(fetch embedded.html 之后),用 ref 让创建时能读到最新主题。
  const themeRef = useRef<Theme>(theme)
  themeRef.current = theme

  // gugu 主题翻转 → 同步会话页挂载元素的 emlight/emdark(保留 gugu-skin 标记)。
  useEffect(() => {
    const mount = mountRef.current
    if (mount) mount.className = sessionSkinClassName(theme)
  }, [theme])

  useEffect(() => {
    const host = hostRef.current
    // StrictMode(dev)对同一实例 setup→cleanup→setup 双调用。这里的挂载是全局一次性副作用
    // (挂载元素放进宿主、会话页入口 import 进来、启动失败的桥装到 window 上),不能被 cleanup 中止——
    // 否则唯一那次 populate 被 cancel → 空白 tab。用 startedRef 保证整段恰好跑一次、不设 cancel。
    if (!host || startedRef.current) return
    startedRef.current = true

    const hostClient = installSessionHostBridge()
    if (hostClient) {
      setHostEndpoint(hostClient.endpoint.url)
      setHostState(hostClient.state())
      hostClient.onStateChange(setHostState)
    }
    // @@@task-fusion (#2802) — 这里从前是 `host.attachShadow({ mode: 'open' })`。
    // shadow root 当初的职责是隔离**两个各自独立的样式系统**;现在只剩一份构建、
    // 一套 token、一道 lint,那个前提消失了,而边界本身开始持续产 bug:浏览器把 CSS 送进
    // document 的每一条正常路径都会在这条边界上失效,于是每遇到一次就打一个补丁 ——
    // 浮层要重定向出 document.body、sonner 的 CSS 要手动再引一次、要挂全局变量让下拉框
    // portal 进来、@font-face 还必须往 head 复制一份(Chromium 不认 shadow 内的 @font-face)、
    // 懒加载 chunk 的样式则整个掉在 head 里进不来(owner 报的「chat UI 只剩文字」即此)。
    // 六个补丁同一个病根。现在改为直接挂进 light DOM:样式投递回到浏览器的默认语义,
    // 隔离改由「会话页自己的全局规则收窄到 .gugu-skin」承担(见 session/renderer/index.css 的说明)。
    const mount = document.createElement('div')
    mount.style.cssText = 'height:100%;width:100%'
    // gugu-skin 皮肤 + 跟随 gugu 当前主题的会话页主题类。
    mount.className = sessionSkinClassName(themeRef.current)
    mountRef.current = mount
    ;(window as unknown as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__ = mount

    // Discover the embedded renderer's transport-specific assets, then load its module into
    // __EMDASH_MOUNT__. Built CSS is attached by the host as links; Vite dev injects CSS through its module graph.
    const appendSkinBridge = () => {
      const bridge = document.createElement('style')
      bridge.setAttribute('data-gugu-skin', '')
      bridge.textContent = GUGU_SKIN_BRIDGE_CSS
      document.head.appendChild(bridge)
    }

    // 会话页 React 真挂上内容(mount 出现子节点)→ 收起 loading 态。慢不算失败:等多久都只是加载态。
    const mountWatch = new MutationObserver(() => {
      if (mount.childElementCount > 0) {
        setLoadState('ready')
        mountWatch.disconnect()
      }
    })
    mountWatch.observe(mount, { childList: true })
    // 会话页起不来 —— 资源没取到、入口 module 载不进来或求值时出错(import 被拒)、renderer bootstrap 失败(经桥报上来)
    // —— 都走这一个处理:错误卡 + fail loud,❌ 半残运行(product spec「打开速度」)。
    const failBoot = (err: unknown) => {
      mountWatch.disconnect()
      setLoadState('error')
      reportFatalBootFailure(err)
    }
    installSessionRendererBootFailureReporter(failBoot)

    void getEmdashAssets()
      .then(async ({ sheetsLoaded, jsUrl }) => {
        // @@@task-fusion (#2802) — 样式进 document.head。拆掉 shadow 后这就是浏览器的默认去处,
        // 会话页自己的全局规则已在 session/renderer/index.css 里收窄到 `.gugu-skin`,不会漫出去伤咕咕。
        if (sheetsLoaded) {
          // 构建 CSS 全部到了再挂内容(不闪无样式的一帧);皮肤桥紧跟在它们后面，赢得层叠。
          await sheetsLoaded
          appendSkinBridge()
        }
        host.appendChild(mount)
        // import() 兑现 = 整张模块图求值完了(等宏任务的顶层 await 也算在内);取文件失败、解析错、求值时抛错、顶层 await
        // 被拒都让它被拒，拒绝原因就是那个真实的错误。一个 promise —— ❌ 再靠 script 的 load / error 去猜:求值抛错只触发
        // load,而 load 也不等顶层 await。
        return importSessionEntry(jsUrl).then(() => {
          // Vite injects imported CSS while evaluating the module. Append the bridge after it so it
          // follows those style tags just as it follows the host-inlined CSS in a built renderer.
          if (!sheetsLoaded) appendSkinBridge()
        })
      })
      .catch(failBoot)
  }, [])

  return (
    <div className="gg-session-frame">
      <div ref={hostRef} className="gg-session-frame-host" />
      {loadState === 'loading' && (
        <div
          className="gg-session-frame-placeholder gg-session-frame-loading"
        >
          <LoadingIndicator size="panel" ariaLabel={t('shell.taskFrame.loading')} />
        </div>
      )}
      {/* 两种失败共用一张卡(棘轮:主渲染层手写按钮数冻结):网页版宿主未连接 / 会话页没能启动。 */}
      {(hostState === 'closed' || loadState === 'error') && (
        <div className="gg-session-frame-placeholder gg-session-frame-error" role="alert">
          <div className="gg-session-frame-error-card">
            <span className="gg-session-frame-error-icon"><AlertCircle size={20} /></span>
            <div className="gg-session-frame-error-title">
              {t(hostState === 'closed' ? 'shell.taskFrame.hostDisconnectedTitle' : 'shell.taskFrame.errorTitle')}
            </div>
            <div className="gg-session-frame-error-copy">
              {t(hostState === 'closed' ? 'shell.taskFrame.hostDisconnectedDescription' : 'shell.taskFrame.errorDescription')}
              {hostState === 'closed' && hostEndpoint && (
                <code className="gg-session-frame-error-endpoint">{hostEndpoint}</code>
              )}
            </div>
            <button
              className="gg-session-frame-retry"
              type="button"
              onClick={() => {
                if (hostState === 'closed') void sessionHostClient?.connect().catch(() => undefined)
                else window.location.reload()
              }}
            >
              <RefreshCw size={15} />
              {t('shell.taskFrame.reload')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
