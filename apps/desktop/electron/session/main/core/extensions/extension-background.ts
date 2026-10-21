import { BrowserWindow } from 'electron';
import { log } from '@main/lib/logger';
import { extensionPartition, extensionResourceUrl } from '@shared/extensions/partition';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { BACKGROUND_PAGE_ARG } from '@shared/extensions/bridge-protocol';
import { configureExtensionSession } from './extension-session';
import { extensionsService } from './extensions-root';
import { resolveExtensionBridgePreload } from './bridge-preload-path';
import type { ExtensionBundle } from './extension-protocol';

/**
 * 一个扩展**一个**常驻后台实例 —— 「跨会话共享的活实例」的载体。
 *
 * owner 2026-09-10:「对我是想要跨会话的活实例」。每条会话页上那一格是**视图**,视图切走
 * 照旧释放;活状态活在这里,所以两条会话看到的是同一个东西,而不是两个互不相干的副本。
 * 番茄钟这类「没人看也得继续跑」的扩展,没有这一层就做不成。
 *
 * 三条边界:
 *  · **声明了才有。**manifest 没写 `background` 的扩展一格后台都不起 —— 这样
 *    [[tab-extensions]]「常驻是例外,不是默认」原样成立,常驻是显式申请来的。
 *  · **与启用状态同生死**,不与 tab 同生死。停用/卸载即销毁;启用即拉起。
 *    ❌ 不能「最后一个 tab 关掉就顺手把它收了」——那又变回了跟视图绑命。
 *  · **不多开。**同一个扩展重复调用只返回已有那一个:后台是单例,这正是它存在的理由。
 *
 * 沙箱不另起一套:它跑在 `configureExtensionSession()` 给的那个已硬化 partition 上,
 * 于是自有 scheme 供文件、网络白名单、权限一律拒这三条与视图完全同源。窗口 `show: false`
 * 且不可见 —— 它是个执行环境,不是界面;界面是那些视图。
 */
const backgrounds = new Map<string, BrowserWindow>();

/**
 * 右键左栏「退出」了的 App(#7050,照 macOS 程序坞):还启用着,但**停着,直到有人再打开它**。
 * 「与启用状态同生死」的唯一例外 —— 是人亲手按的,不是哪个 tab 关掉的副作用。再打开 = 它的页又被要了
 * (`extensionOpened`,任何一处 activate 都算);咕咕重开时不记得,启用的照常起来(同 macOS 重启后登录项照起)。
 */
const quitUntilOpened = new Set<string>();

function startExtensionBackground(manifest: ExtensionManifest, bundle: ExtensionBundle): void {
  const backgroundEntry = manifest.background?.entry;
  if (!backgroundEntry) return;

  const existing = backgrounds.get(manifest.id);
  if (existing && !existing.isDestroyed()) return;

  // 桥与 webview 那条同源(`webview-policy` 走的是同一个 resolver):后台页拿到的
  // `window.gugu` 必须和视图里那个是同一份,否则「同一个扩展」在两种载体上就是两套 API。
  // ❌ 不静默降级 —— 少了桥,后台会以「跑着但什么都不响应」的样子存在,那比不起更难查。
  const preloadPath = resolveExtensionBridgePreload(__dirname);
  if (!preloadPath) {
    log.error('Refusing extension background: bridge preload is missing from this build', {
      extensionId: manifest.id,
    });
    return;
  }

  // 先把 partition 硬化好再开窗:窗口一挂上去就会开始取资源,这一步晚一拍,
  // 第一批请求就走在没有网络闸的 session 上。
  configureExtensionSession(bundle);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: extensionPartition(manifest.id),
      preload: preloadPath,
      // Its `gugu` is the background page's: no tab, no gesture (`VerbFacts.only`).
      additionalArguments: [BACKGROUND_PAGE_ARG],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      // 后台没有界面,也就没有理由让它把自己画出来或弹出任何东西。
      backgroundThrottling: false,
    },
  });

  // 后台页不许开新窗口:它没有界面,任何「弹一个出来」都不是它该有的动作。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('render-process-gone', (_event, details) => {
    // 说出来而不是静默重启:一个反复崩溃的后台会变成看不见的重启循环。
    log.error('Extension background process gone', { extensionId: manifest.id, details });
  });

  backgrounds.set(manifest.id, win);
  // 说出来:一个**看不见的常驻进程**被拉起来了,而它没有任何界面会证明自己在。
  // 不记这一条,「后台到底起没起」就只能靠猜 —— 排查时那等于没有证据。
  log.info('Extension background started', {
    extensionId: manifest.id,
    entry: backgroundEntry,
    webContentsId: win.webContents.id,
  });
  void win.loadURL(extensionResourceUrl(manifest.id, backgroundEntry)).catch((error: unknown) => {
    log.error('Extension background failed to load', { extensionId: manifest.id, error });
  });
}

/** 停用 / 卸载 / 退出:后台跟着启用状态走,所以这里是它唯一的终点。 */
export function stopExtensionBackground(extensionId: string): void {
  const win = backgrounds.get(extensionId);
  backgrounds.delete(extensionId);
  if (!win || win.isDestroyed()) return;
  log.info('Extension background stopped', { extensionId });
  win.destroy();
}

/** 「退出」:后台停下,并且对账时不再拉起,直到它再被打开。 */
export function quitExtension(extensionId: string): void {
  quitUntilOpened.add(extensionId);
  stopExtensionBackground(extensionId);
}

/** 它的页又被要了:退出作废,该有后台的拉起来。返回这一下有没有改变「退出了哪些」。 */
export function extensionOpened(extensionId: string): boolean {
  if (!quitUntilOpened.delete(extensionId)) return false;
  syncExtensionBackgrounds();
  return true;
}

/** 停用 / 卸载:它已经不在跑了,「退出」随之作废 —— 再启用就照常拉起(启用即在跑)。返回有没有改变。 */
export function forgetQuit(extensionId: string): boolean {
  return quitUntilOpened.delete(extensionId);
}

/** 此刻「退出了、还没再打开」的 App —— 渲染层据此知道它的后台没在跑(左栏那个小点)。 */
export function quitExtensions(): string[] {
  return [...quitUntilOpened];
}

export function stopAllExtensionBackgrounds(): void {
  for (const extensionId of [...backgrounds.keys()]) stopExtensionBackground(extensionId);
}

/** 这个扩展现在有没有后台在跑 —— 判据给测试和设置页读,❌ 别在别处另存一份状态。 */
export function extensionBackgroundWebContentsId(extensionId: string): number | null {
  const win = backgrounds.get(extensionId);
  if (!win || win.isDestroyed()) return null;
  return win.webContents.id;
}

/** Every background running now, `[extensionId, webContentsId]` — for an event each one hears as its own (agentsChanged). */
export function runningExtensionBackgrounds(): [string, number][] {
  return [...backgrounds.keys()].flatMap((extensionId) => {
    const id = extensionBackgroundWebContentsId(extensionId);
    return id === null ? [] : [[extensionId, id] as [string, number]];
  });
}


/**
 * 把「现在该有哪些后台在跑」对一次账 —— 启用/停用、装/卸、开机各调这一个。
 *
 * 只有一个对账入口,因为后台的存在条件是**算出来的**(装着 + 启用 + 声明了 background),
 * 不是某个事件的副作用。各处各写一段 start/stop,迟早会出现「停用了但还在跑」
 * 或「装回来了却不跑」——那种错不报错,只是悄悄多一个或少一个进程。
 */
export function syncExtensionBackgrounds(): void {
  const service = extensionsService();
  const { extensions } = service.list();
  const shouldRun = new Set<string>();

  for (const installed of extensions) {
    const { manifest, rootDir } = installed;
    if (!manifest.background?.entry) continue;
    if (!service.isEnabled(manifest.id)) continue;
    if (quitUntilOpened.has(manifest.id)) continue;
    shouldRun.add(manifest.id);
    try {
      startExtensionBackground(manifest, {
        extensionId: manifest.id,
        rootDir,
        networkHosts: service.grantedHosts(manifest.id),
      });
    } catch (error: unknown) {
      // 一个扩展的后台起不来(比如无头宿主里根本没有 BrowserWindow),只记这一条:
      // 别的扩展照起,下面「该停的停掉」照跑。
      log.error('Extension background failed to start', { extensionId: manifest.id, error });
    }
  }

  for (const extensionId of [...backgrounds.keys()]) {
    if (!shouldRun.has(extensionId)) stopExtensionBackground(extensionId);
  }

  // 对完账说一句「该有几个」。「一个都不该有」和「该有却没起来」在日志里必须分得开 ——
  // 两种情况的现象都是「没有后台在跑」,而只有前者是正常的。
  log.info('Extension backgrounds synced', {
    installed: extensions.length,
    declaring: extensions.filter((e) => e.manifest.background?.entry).length,
    running: shouldRun.size,
  });
}
