// 会话启动失败账本 —— 「这条会话的 hydrate 以什么理由停在了失败态」在 renderer 侧的唯一记录处(#4602)。
//
// 为什么不是一条 toast:sonner 的 <Toaster/> 只挂在会话页 Workspace 根上,而对话页「新建 Agent」时
// 这棵树渲染的是 composer 根、用户切走 tab 时又是 display-hidden。toast 发进一棵没人看的树,等于没发 ——
// 用户面对一个既不回复也不报错的私聊。所以失败事实先写进这份账本,任务页内容区那一格与对话页的 DM 横幅
// 都只是它的读者;谁在场谁显示,❌ 不由发失败的一方猜用户在哪。两个读者说同一句(`describe`,#7103)。
//
// 与主进程 durable 状态的关系:startSession 的 try 内失败(POST /session 超时、没有该腿的物化器、grant
// 持有人不符…)主进程会经 emitSessionSpawnFailure 落 agent_status='error'(侧栏失败标记),但那份投影
// 不带 message、DM 也不渲染它、且 error 不在后来成功启动时复位;startSession 之前的 throw(Conversation /
// Task not found)则什么都不落。本账本记的是 renderer 手上那次 hydrate 的**原文 + 可重试性**,与主进程的
// durable 标记并存 —— 把两者统一到主进程投影上是另一层的改动(见 PR #4719 的后续 issue),不在这里做。
//
// 覆盖面:只有 PTY(tui)腿的 SessionPtyManager 往这里写;ACP 腿(Chat UI 开)的启动失败走
// AcpChatStore.loadError,不经本账本。
//
// 跨 bundle:gugu 主渲染层与本页是同一文档里的两棵 React 树、两份 module graph,module 级单例跨不过去。
// 出口沿用既有做法 —— 一个 window 全局适配对象(与 __EMDASH_SET_EMBED_VIEW__
// 同一种边界),由 embedded.tsx 在**每次**入口求值时装上(热更新会重新求值入口模块,装晚了就会指向上一份
// module 实例的空 Map);独立打开的 session-embedded.html 不装,账本照常工作。
//
// 生命周期由 SessionPtyManager 驱动:hydrate 失败(且这条会话仍有标签页要它)→ report;显式重试 →
// markRetrying(重试成功 → clear,再失败 → 重新 report);该会话最后一个标签页关闭 → clear。账本自己不做超时、
// 不做去抖 —— 失败是终态,它消失的途径只有上面两条。

import type { RuntimeUpgradeRequirement } from '@shared/core/sessions/runtime-upgrade';
import { failureReason, failureText, guguReasonCopy } from '../gugu-reason';
import { translateSessionMessage } from '@renderer/localization/locale-store';

export interface SessionStartupFailure {
  sessionId: string;
  /** 主进程抛出的原文(咕咕这一侧的失败只是一个原因码)。给人看的那句由 `describe` 说:原因表,或拒绝方原话的一行(#7103)。 */
  message: string;
  /** 已按下重试、hydrate 正在飞:读者把重试出口禁用并如实写「重试中」,❌ 不把这一段显示成「没事了」。 */
  retrying: boolean;
  /**
   * 这次失败是不是「harness 版本低于下界」(#6341)—— 主进程对这条会话最近一次启动失败的判定。
   * null = 不是(或还没取回来)。有它时读者给出升级出口,而不只是一句原文 + 重试。
   */
  runtimeUpgrade: RuntimeUpgradeRequirement | null;
}

type Entry = SessionStartupFailure & { retry: () => void };

/** 交给另一棵树读的那一面:只读快照 + 订阅 + 重试。写入口不出边界。 */
export interface SessionStartupFailureBridge {
  snapshot(): readonly SessionStartupFailure[];
  subscribe(listener: () => void): () => void;
  /** Rehydrate; false means the entry disappeared during a legitimate race. */
  retry(sessionId: string): boolean;
  /** Display the reason catalog or the sanitized actual cause; keep the legacy origin argument compatible. */
  describe(message: string, origin?: 'gugu'): { text: string; retryable: boolean };
}

export const SESSION_STARTUP_FAILURE_BRIDGE_KEY = '__EMDASH_SESSION_STARTUP_FAILURES__';

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
// useSyncExternalStore 要求 getSnapshot 在没有变化时返回同一引用,所以快照只在写入时重算。
let snapshot: readonly SessionStartupFailure[] = [];

function publish(): void {
  snapshot = [...entries.values()].map(({ sessionId, message, retrying, runtimeUpgrade }) => ({
    sessionId,
    message,
    retrying,
    runtimeUpgrade,
  }));
  for (const listener of listeners) listener();
}

export const sessionStartupFailures = {
  report(entry: Omit<Entry, 'retrying' | 'runtimeUpgrade'>): void {
    entries.set(entry.sessionId, { ...entry, retrying: false, runtimeUpgrade: null });
    publish();
  },
  /**
   * 给**当前这条**失败补上主进程的版本判定。条目已经不在(重试成功 / 标签页关掉)或已进入新一轮重试
   * ⇒ 这份判定属于上一次失败,丢掉 —— 下一次失败会重新取。
   */
  setRuntimeUpgrade(sessionId: string, runtimeUpgrade: RuntimeUpgradeRequirement | null): void {
    const entry = entries.get(sessionId);
    if (!entry || entry.retrying) return;
    entries.set(sessionId, { ...entry, runtimeUpgrade });
    publish();
  },
  /** 重试已开始:条目留着(读者据此显示「重试中」),结果由后续的 clear / report 决定。 */
  markRetrying(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry || entry.retrying) return;
    entries.set(sessionId, { ...entry, retrying: true });
    publish();
  },
  clear(sessionId: string): void {
    if (entries.delete(sessionId)) publish();
  },
  has(sessionId: string): boolean {
    return entries.has(sessionId);
  },
  snapshot(): readonly SessionStartupFailure[] {
    return snapshot;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry(sessionId: string): boolean {
    const entry = entries.get(sessionId);
    if (!entry || entry.retrying) return false;
    entry.retry();
    return true;
  },
};

export const sessionStartupFailureBridge: SessionStartupFailureBridge = {
  snapshot: sessionStartupFailures.snapshot,
  subscribe: sessionStartupFailures.subscribe,
  retry: sessionStartupFailures.retry,
  describe: (message) => {
    const reason = failureReason(message);
    const action = reason ? guguReasonCopy(reason).action : 'retry';
    return {
      text: failureText(message, translateSessionMessage),
      retryable: action === 'retry' || action === 'sign-in',
    };
  },
};

/** 装到宿主文档的 window 上,让 gugu 那棵树读得到。幂等:同一份 module 实例装几次都是同一个对象。 */
export function installSessionStartupFailureBridge(target: Window): void {
  (target as unknown as Record<string, unknown>)[SESSION_STARTUP_FAILURE_BRIDGE_KEY] = sessionStartupFailureBridge;
}
