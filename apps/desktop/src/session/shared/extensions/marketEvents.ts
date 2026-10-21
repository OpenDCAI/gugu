import { defineEvent } from '@shared/lib/ipc/events';
import type { FirstRunState } from './first-run';
import type { MarketDownloadProgress } from './market';
import type { MarketRefreshed } from './market-snapshot';

/**
 * 主进程 → 渲染层:云端包的下载进度(#5410)。
 *
 * 为什么要推而不是让界面问:下载是一次 RPC 里的一段,RPC 只在结束时回话;不推,按钮就只能
 * 从「读取中…」一直转到结束,网差时看上去和卡死一样。`total` 是清单上登记的字节数,
 * 所以从第一包起就有百分比。
 */
export const marketDownloadProgressChannel = defineEvent<MarketDownloadProgress>(
  'extensions.market.download-progress'
);

/**
 * 主进程 → 渲染层:这台机器上装着的扩展被**别的桌面**改了(#6264,资源库切到这台机器后装 / 卸 / 开关)。
 * 本机窗口里的改动由界面自己跟进;别处来的改动没人告诉这个窗口,它据此重读清单、补上或撤下 tab。
 */
export const extensionsInventoryChangedChannel = defineEvent<{ extensionId?: string }>(
  'extensions.inventory.changed'
);

/**
 * 主进程 → 渲染层:「退出了、还没再打开」的 App 变了(#7050)。退出是界面按的,再打开却可能发生在任何一处
 * (左栏、「+」、群右栏「用 X 打开」、agent 开的页签)—— 主进程在它的页被要的那一刻知道,推给界面,左栏那个小点据此跟上。
 */
export const extensionsQuitChangedChannel = defineEvent<{ quit: string[] }>('extensions.quit.changed');

/**
 * 主进程 → 渲染层:去下载站取了一趟市场目录(market-snapshot.ts),变了 / 没变 / 没取到。市场页和「有新版 / 被撤回」读的是
 * 手上同一份目录,`changed` 时两边一起重读;`failed` 时照旧画手上那份、安静写「上次更新于 …」。
 * 打开 App 页那一趟的结果也由 `marketRefresh` 的回答带回(别的机器的推送未必转得过来)。
 */
export const marketRefreshedChannel = defineEvent<MarketRefreshed>('extensions.market.refreshed');

/**
 * 主进程 → 渲染层:首启默认组里还在路上的 App、这个 profile 还有没有没装完的,变了(161 10-16)。群面板对它们会开的文件说
 * 「正在装好」,装上就当场打开;一个这次没装上(`installing: false`)就说还没装好、可以再试;还没读到市场(`pending` 而没有 App)
 * 时打开一个没人能开的文件,先再试一次首启。
 */
export const firstRunArrivingChannel = defineEvent<FirstRunState>('extensions.first-run.arriving');

/**
 * 主进程 → 每个连着这台机器的窗口:这台机器上一个 App 的程序发了一条通知(owner 10-16「程序跟着数据」)。本机的页面由主进程直接收;
 * 别的桌面上绑在这台机器某条会话上的页面,由那台桌面的界面收下、交给它的主进程送到那几张页(`programNotifiedElsewhere`)。
 */
export const extensionProgramNotifiedChannel = defineEvent<{ extensionId: string; server: string; method: string; params?: unknown }>(
  'extensions.program.notified'
);
