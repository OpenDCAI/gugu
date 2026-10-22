// gugu-embedded entry: mount the session-page <App/> into a host-provided container
// (window.__EMDASH_MOUNT__) instead of light-DOM #root, so gugu can portal it into a
// Shadow DOM at the 会话页 tab (one build / one process / CSS-isolated, NOT a webview).
// The gugu host sets window.electronAPI (stub or real RPC bridge) BEFORE loading this bundle.
// 会话页是独立文档,壳里装的垫片不跨文档:非安全上下文(http://<ip>)下 crypto.randomUUID 缺席会让这里启动即白。
import '@/lib/insecure-context-shims';
import { hasEntryRoot, renderEntryRoot } from '@/lib/renderer-entry-root';
import { installRemoteHostSessionpageBridges } from './features/remote-hosts/install-sessionpage-bridges';
import './lib/install-sessionpage-history-bridge';
import { setupNavigationGuards } from '@renderer/app/view-registry';
import { prefetchAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
// @@@task-fusion (#2802) — session-ui 的 CSS 栈按它自己文档的契约显式引一次。
// 从前这里是一行 `@gugu/session-ui/style.css`,那是 tsdown/vite lib 把下面这些打成的
// 产物;并入本体后包按源码消费,VE 桶(layers/tokens/surfaces/reset/sprinkles/
// 动画/SVG)与几个纯 CSS 文件各自入图 —— 内容与旧 dist/style.css 一一对应。
// session-chat-ui 不需要对应的一行:它的 src/index.tsx 头部自带 styles/global.css。
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@gugu/session-ui/styles/typography.css';
import '@gugu/session-ui/styles/overflow-fade.css';
import './index.css';
// @@@font-single-source (#3334) — 等宽规格是 JetBrains Mono Variable(见 tokens.css 的
// --font-family-mono)。它的 @font-face 从前只由 ChatRoot 引入,于是「开过 transcript」与
// 「没开过」两种状态下,会话页其余地方的等宽字是两张脸。在入口引一次,让它恒定可用。
import '@fontsource-variable/jetbrains-mono/index.css';
// @@@terminal-cjk-cell (#5586) — 终端的等宽中文字形。它必须与 JetBrains 一样在入口引一次:
// 终端按格子排版,中文一旦回退到系统字体,宽度比就不是整数,行尾会被切掉。见 sarasa-mono.css。
import '@/styles/sarasa-mono.css';
import { watchTerminalFontReady } from '@renderer/lib/pty/terminal-font-ready';
import 'devicon/devicon.min.css';
import 'katex/dist/katex.min.css';
// sonner normally injects its CSS into document.head at runtime — invisible from inside the
// shadow root, so toasts render as a bare <ol>. Import it here so it lands in the build CSS
// that the gugu host injects INTO the shadow root (the head copy is a harmless duplicate).
import 'sonner/dist/styles.css';
import { registerInstalledExtensionTabs } from '@renderer/features/extensions/register-extension-tabs';
import { wireRemoteExtensionResync } from '@renderer/features/extensions/wire-remote-extension-resync';
import { wireMarketRefresh } from '@renderer/features/extensions/wire-market-refresh';
import { wireProgramNotifications } from '@renderer/features/extensions/wire-program-notifications';
import { wireAppQuit } from '@renderer/features/extensions/app-dock';
import { wireExtensionHostActions } from '@renderer/features/extensions/wire-extension-host-actions';
import { setupAppCommandProvider } from '@renderer/lib/commands/app-commands';
import { setupViewCommandProvider } from '@renderer/lib/commands/registry';
import { wireCommitHistoryInvalidation } from '@renderer/lib/commit-history-invalidation';
import { wireExternalLinkRequests } from '@renderer/lib/external-link-requests';
import { wireSessionsOnScreenReport } from '@renderer/app/sessions-on-screen';
import { rpc } from '@renderer/lib/ipc';
import { wireModelRegistryInvalidation } from '@renderer/lib/monaco/invalidation-bridges';
import { monacoBootstrap } from '@renderer/lib/monaco/monaco-bootstrap';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { wirePrCacheInvalidation } from '@renderer/lib/pr-cache-invalidation';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { log } from '@renderer/utils/logger';
import { initSoundPlayer } from '@renderer/utils/soundPlayer';
import type { NavigationSnapshot, SidebarSnapshot } from '@shared/view-state';
import { App } from './App';
import { migrateRenamedLocalStorageKeys } from './lib/renamed-storage-keys';
import { ErrorBoundary } from './lib/components/error-boundary';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { setEmbedVisible, setPortalContainer } from './lib/portal-container';
import { setEmbedView, type EmbedView } from './lib/stores/embed-view';
import { installSessionStartupFailureBridge } from './features/sessions/stores/session-startup-failures';
import { installSessionViewRequestBridge } from './features/sessions/stores/session-view-requests';
import { openChatOnScreen, openSessionOnScreen } from './features/chats/open-chat';
import { installSessionTabViews, prewarmSessionTabViews } from './features/sessions/session-tab-views';
import { appState } from './lib/stores/app-state';
import { SessionLocalizationProvider } from './localization/localization-provider';
import { reportSessionRendererBootFailure } from '@/session/shared/lib/session-renderer-boot';

declare global {
  interface Window {
    __EMDASH_MOUNT__?: HTMLElement;
  }
}

const OPTIONAL_BOOTSTRAP_TIMEOUT_MS = 5_000;

async function settleOptional<T>(promise: Promise<T> | null): Promise<T | null> {
  if (!promise) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OPTIONAL_BOOTSTRAP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把本页这棵树渲染进它的 root。
 *
 * 单独拆出来是因为它有**两个**调用点:首次 bootstrap 的末尾,以及热更新重新求值时的快路径。
 * 后者只重渲染、不重跑一次性接线 —— 见 `bootstrap()` 开头那段。
 */
function renderSessionTree(container: HTMLElement, mountEl: HTMLElement | undefined): void {
  renderEntryRoot(
    'session-embedded',
    container,
    // 本页的浮层落在本页的挂载元素里 —— 它带着会话页的主题类(.emlight/.emdark + .gugu-skin),
    // 也跟着本页一起显示/隐藏。
    // ⚠️ 这里是 `mountEl` 而**不是** `container`:独立打开 session-embedded.html 时没有
    // `__EMDASH_MOUNT__`,container 退化成 `#root`,而 `setPortalContainer(mountEl)`
    // 在这条路径上根本没执行 —— 本页自己那套 lib/ui 浮层仍落 document.body。两边给不同的答案,
    // 就会出现「session-ui 的 popover 从 lib/ui 的 dialog 里弹出来,却在另一个层叠上下文里」。
    // 传 null ⇒ 两套机制在这条路径上都回到 Base UI 的 document.body 默认,同一棵树只有一个答案。
    <UiPortalContainerProvider value={mountEl ?? null}>
      <SessionLocalizationProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </SessionLocalizationProvider>
    </UiPortalContainerProvider>
  );
}

async function bootstrap() {
  // Portals (Base UI dialogs/popovers/tooltips + raw createPortal) must stay inside the shadow
  // root — document.body is outside it and has none of the session page's CSS (dialogs render as bare
  // unstyled text there). Give them a dedicated layer next to the app mount. Must run before
  // any init below: monacoBootstrap's theme probe already reads CSS vars via this container.
  const mountEl = window.__EMDASH_MOUNT__;

  // 页签的界面那半由这里登记(@@@tab-views):provider 里只留按 kind 取内容的薄壳。登记幂等,热更新再跑一遍无妨。
  // 宿主的 prewarmEmdashAssets 把这个入口预先拉下来求值;入口一起来,就趁空闲把各页签的界面也载好,第一次打开不再现等。
  installSessionTabViews();
  requestIdleCallback(() => prewarmSessionTabViews());

  // ⚠️ 热更新会**重新执行整个入口模块** ⇒ `bootstrap()` 会被跑第二遍。下面那一整段是**一次性**
  // 接线(可见性桥、命令提供者、缓存失效桥、扩展注册、导航/侧栏快照恢复),跑第二遍会挂重复监听,
  // 并把开发者手上的导航位置拽回快照。已经有 root 就说明这一遍是热更新,只重渲染。
  // 入口脚本是 `<script type="module">`(defer),模块执行时文档已解析完 ⇒ 这里取 `#root` 安全。
  const container = mountEl ?? (document.getElementById('root') as HTMLElement);
  // #4602: 会话启动失败账本的读端交给宿主 —— 对话页那棵树据此在当前 DM 里把 hydrate 失败显形。
  // 同一种边界(window 全局适配对象),方向是本页 → 宿主;见 session-startup-failures.ts 抬头。
  // ⚠️ 必须在下面那个热更新早返回**之前**:热更新会重新求值整条 import 链,账本是新的一份 module 实例,
  //    桥要跟着指向新的那份,否则宿主读的是旧实例里那张永远空着的 Map。装桥本身幂等,每次求值都装无妨。
  installSessionStartupFailureBridge(window);
  // #7167 聊天页那颗模式按钮选了编程 / 通用:打开任务之后请这一页换展示(session-view-requests.ts)。同上,热更新前装。
  // gugu-dev#181 壳要打开一条对话:对话是这屏的一块(项目群开项目块)。
  installSessionViewRequestBridge(window, { openChat: openChatOnScreen, openSession: openSessionOnScreen });
  installRemoteHostSessionpageBridges(window, () => appState.navigation.navigate('new-session'));
  if (hasEntryRoot(container)) {
    renderSessionTree(container, mountEl);
    return;
  }
  // @@@task-fusion (#2802) — 拆掉 shadow root 后浮层不再需要重定向:document.body 就在同一棵
  // 文档树里,会话页的主题类由挂载元素(.emlight/.emdark + .gugu-skin)向下继承,portal 到
  // body 的浮层则由 host 在 body 上同步同一组类来解析主题变量。
  // ⚠️ 下面这段可见性接线**必须留在 shadow 判断之外**:它从前写在 `if (mountRoot instanceof
  // ShadowRoot)` 里面,没有 shadow 就永远不会执行 —— host 切走「任务」tab 时收不起来,
  // 文档级快捷键会一直挂着。这是拆 shadow 最容易漏掉的一处连带影响。
  const w = window as unknown as {
    __EMDASH_SET_VISIBLE__?: (v: boolean) => void;
    __EMDASH_EMBED_VISIBLE__?: boolean;
  };
  w.__EMDASH_SET_VISIBLE__ = setEmbedVisible;
  if (w.__EMDASH_EMBED_VISIBLE__ === false) setEmbedVisible(false);
  if (mountEl) {
    // 浮层容器 = 挂载元素本身:Base UI 的 portal 落在它下面即可继承主题类,不必再造一层。
    // @@@4321 这里从前还往 `window.__EMDASH_PORTAL_CONTAINER__` 写一份给 @gugu/session-ui 读。
    // 那是个**文档级**全局,而咕咕主渲染层与本页是同一文档里的两棵 React 树、共用同一份
    // session-ui —— 于是主渲染层(创建向导等)的弹层也被吸进本页这个「常驻挂载、平时隐藏」的
    // overlay,打开了却不可见也点不到。改由 React context 按树声明(下方 UiPortalContainerProvider),
    // 谁在本页的树里,谁才 portal 到本页的浮层。
    setPortalContainer(mountEl);
  }

  // gugu #2549: the ONE persistent embed instance can render either the full session-page Workspace
  // or a composer-only root (对话页原地创建 Agent) — see lib/stores/embed-view.ts for why this is a
  // reactive switch on a single instance rather than a second independent module load. The host
  // (gugu MainLayout) flips this via __EMDASH_SET_EMBED_VIEW__ whenever it needs the embed to show
  // a different root; App.tsx reads the store reactively. __EMDASH_EMBED_VIEW__ only seeds the
  // initial value for a host that set it before this bundle finished loading.
  const embedViewWindow = window as unknown as {
    __EMDASH_SET_EMBED_VIEW__?: (v: EmbedView) => void;
    __EMDASH_EMBED_VIEW__?: EmbedView;
  };
  embedViewWindow.__EMDASH_SET_EMBED_VIEW__ = setEmbedView;
  if (embedViewWindow.__EMDASH_EMBED_VIEW__) {
    setEmbedView(embedViewWindow.__EMDASH_EMBED_VIEW__);
  }

  // 改名前写下的本地存储键(`emdash:*`)搬到新名字下 —— 要在任何读它们的界面渲染之前。
  try {
    migrateRenamedLocalStorageKeys(localStorage);
  } catch {
    /* storage blocked */
  }

  wireModelRegistryInvalidation(modelRegistry);
  wirePrCacheInvalidation();
  wireCommitHistoryInvalidation();
  wireExternalLinkRequests();
  // 屏上的会话报给主进程:闲置回收不停人正看着的会话(spec idle-reclaim「不在屏上」)。
  wireSessionsOnScreenReport();

  initSoundPlayer();

  // Monaco must NOT gate the mount: even vendored locally it is a multi-MB async chunk.
  // Editors await monacoBootstrap.init() themselves when opened — boot it in the background
  // and render the app immediately.
  void monacoBootstrap.init().catch((error: unknown) => {
    log.warn('[monaco-bootstrap] init failed:', error);
  });

  // View-state/settings restoration is additive. Do not hold the only React mount behind a
  // non-critical RPC: a stale KV record, a first-run settings read, or a project mount failure
  // must leave the task surface usable and visible rather than an endless host skeleton.
  // Project loading is store-owned and may continue after the first render; it must never hold
  // the only React mount behind a slow database or filesystem call.
  void appState.projects.load().catch((error: unknown) => {
    log.warn('Project bootstrap failed:', error);
  });

  // Extensions register their tab providers off the critical path (#2374): a tab whose provider
  // has not arrived yet is held as a placeholder and promoted in place once it registers, so the
  // session page never waits on an inventory read to become usable.
  void registerInstalledExtensionTabs().catch((error: unknown) => {
    log.warn('Extension tab registration failed:', error);
  });
  // 有新版 / 被撤回 / 已弃用的提示在启动时查一次(#5410 spec:❌ 轮询、❌ 横幅),之后跟着市场目录变 ——
  // 同样脱离关键路径,失败只进日志(installedExtensionsStore.checkUpdates 自己兜底)。
  wireMarketRefresh();
  wireProgramNotifications();
  wireRemoteExtensionResync();
  // 左栏「开着」的小点:哪些 App 退出了、还没再打开,由主进程推过来(#7050)。
  wireAppQuit();
  // Synchronous on purpose: main refuses to deliver an extension's action until
  // this side has declared itself ready, so an extension that acts the instant
  // its surface loads must not race the bootstrap's awaits.
  wireExtensionHostActions();
  const results = await Promise.allSettled([
    settleOptional(rpc.viewState.get('navigation') as Promise<NavigationSnapshot> | null),
    settleOptional(rpc.viewState.get('sidebar')),
    settleOptional(rpc.viewState.getAll()),
    settleOptional(prefetchAppSettingsKey('interface')),
    settleOptional(prefetchAppSettingsKey('browser')),
  ]);
  const [navState, sidebarState, allViewStateResult] = results;
  for (const result of results) {
    if (result.status === 'rejected') log.warn('Renderer bootstrap optional state failed:', result.reason);
  }
  const navResult = navState.status === 'fulfilled' ? (navState.value as NavigationSnapshot) : null;
  const sidebarResult = sidebarState.status === 'fulfilled' ? sidebarState.value : null;
  const allViewState = allViewStateResult.status === 'fulfilled' && allViewStateResult.value
    ? (allViewStateResult.value as Record<string, unknown>)
    : {};

  viewStateCache.populate(allViewState);

  setupNavigationGuards();
  if (navResult) appState.navigation.restoreSnapshot(navResult);
  setupAppCommandProvider();
  setupViewCommandProvider();
  if (sidebarResult) {
    appState.sidebar.restoreSnapshot(sidebarResult as Partial<SidebarSnapshot>);
  } else {
    appState.sidebar.expandAllProjects();
  }

  renderSessionTree(container, mountEl);
}

// @@@terminal-cjk-cell (#5586) — 不 await:终端字体只影响「格子量得准不准」,不该挡在首帧前面。
// 它落地后自己广播一次重测,见 terminal-font-ready.ts。
watchTerminalFontReady();

bootstrap().catch((error: unknown) => {
  log.error('Renderer bootstrap (embedded) failed:', error);
  reportSessionRendererBootFailure(error);
});
