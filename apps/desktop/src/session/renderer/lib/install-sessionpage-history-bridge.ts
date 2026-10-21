import { reaction } from 'mobx';
import {
  installSessionpageHistoryBridge,
  type SessionpageHistoryBridgeWindow,
} from '@/lib/sessionpageHistoryBridge';
import { navigateBack, navigateForward } from '@renderer/lib/components/nav-buttons';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * 把会话页自己的后退/前进历史交给咕咕壳(Windows 标题栏的 ← →,见 lib/sessionpageHistoryBridge.ts)。
 * 走的是会话页 NavButtons 与 Mod+[ / Mod+] 同一条路径,壳这边❌ 另记一份会话页历史。
 *
 * 由入口(embedded.tsx)以副作用 import 引入、模块求值时就装:热更新重新求值 import 链时跟着重装,
 * 桥指向新的那份 appState(与同文件里 installRemoteHostSessionpageBridges 放在热更新早返回之前是同一个理由)。
 * 入口文件在 IM 迁移账本里、有行数预算(scripts/im-architecture-migration-gate.json)—— 这也是它不在入口里显式调用的原因。
 */
function installSessionpageHistory(w: Window): void {
  installSessionpageHistoryBridge(w as unknown as SessionpageHistoryBridgeWindow, {
    canGoBack: () => appState.history.canGoBack,
    canGoForward: () => appState.history.canGoForward,
    back: () => navigateBack(appState.history.canGoBack),
    forward: () => navigateForward(appState.history.canGoForward),
    // index 是这份 store 唯一的可观察量(entries 故意不观察);前进栈被截断时 index 也会变。
    subscribe: (listener) => reaction(() => appState.history.index, () => listener()),
  });
}

installSessionpageHistory(window);
