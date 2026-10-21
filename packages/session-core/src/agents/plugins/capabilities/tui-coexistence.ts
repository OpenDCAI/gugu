/**
 * TUI 腿的共处通道 —— 与 ACP 腿那条协议通道对称的那一根。
 *
 * 为什么要有这个文件:八维共处能力(见 `session-bundle.ts` 的 `SessionCoexistence`)几乎全建
 * 在 ACP 腿上 —— 走 ACP 的家,`pause` / `observability` / `askUser` 三维由**同一套**协议机制
 * 一次点亮,各家的声明可以照抄同一段依据(见 `impl/cline/index.ts:28` 那段注释)。TUI 腿没有
 * 这样一根主干:回传是有的,但散在各家的 `hooks.ts` / `plugin-file.ts` 里,descriptor 层看不见,
 * 于是「这家到底接没接通」只能靠人肉比对,声明与实现随时会漂。
 *
 * 这里把它收敛成两条可判定的事实:
 *
 * 1. **回传通道**(`resolveTuiHookReturn`)—— 引擎自己的 hook / plugin 事件系统 POST 到
 *    `GUGU_HOOK_PORT`,宿主 HookServer 收下、落成会话状态。它是 TUI 腿**唯一**的
 *    `observability` 来源,通道名 `event-stream`。
 * 2. **中断键**(`SessionTuiInterrupt` + `tuiInterruptWrites`)—— 宿主往 pty 写这一家自己的中断
 *    字节。它是 TUI 腿**唯一**的 `pause` 来源,通道名 `interrupt-key`。
 *
 * ⚠️ 两条都声明「咕咕接没接通」,不是「厂商有没有」。厂商侧归 #3889 的官方证据矩阵。
 */

import type { HookEvent } from './hooks-types';
import { declaresSessionTuiLeg } from './session-bundle';
import type {
  HarnessSessionSurface,
  SessionCoexistence,
  SessionTuiInterrupt,
} from './session-bundle';

export type { SessionTuiInterrupt };

/**
 * hooks descriptor 的结构切片 —— 只取本模块判定要用的两个字段。
 *
 * ❌ 不直接 import `hooksCapability` 的推导类型:那会让 core 内部两个能力互相依赖具体
 * schema 形状,而本模块只关心「装不装得上」与「报哪些词」。
 */
export type TuiHooksShape =
  | { kind: 'none' }
  | { kind: 'config' | 'plugin'; supportedEvents: readonly HookEvent[] };

/**
 * 判「本轮结束了」的**唯一**词:`stop`。
 *
 * 为什么以 stop 为准而不是 start:`start` 那一半宿主自己也能凑出来 ——
 * `agent-hook-service.ts:80 providerSupportsNativeStartHook()` 对没有原生 start 的家,会拿
 * 「用户按了回车」(`session:input-submitted`)合成一个 start 事件。那是**宿主的推断**,
 * 不是 harness 自己报的,按本维定义不算数。`stop` 没有等价的推断:pty 还活着、屏幕还在动,
 * 宿主没有任何办法判断这一轮完没完 —— 只有引擎自己说了才算。
 *
 * 所以:报得出 stop = 这一家的 TUI 腿真有读侧观测;报不出 = 咕咕对它这一维是瞎的,
 * 哪怕它同时报了 start。
 */
export const TUI_TURN_BOUNDARY_HOOK_EVENT = 'stop' satisfies HookEvent;

/** TUI 腿回传通道的判定结果。 */
export type TuiHookReturn =
  | { kind: 'installed'; events: readonly HookEvent[] }
  /** 这一家没有 hooks descriptor —— 咕咕从没给它写过 hook / plugin 文件。 */
  | { kind: 'absent' }
  /** 有 hook,但报不出回合边界(没有 `stop`)—— 收得到零星通知,读不出「这一轮完了」。 */
  | { kind: 'no-turn-boundary'; events: readonly HookEvent[] };

/**
 * 这一家的 TUI 腿有没有一条活着的回传通道。
 *
 * ⚠️ 只看 descriptor 不够,但 descriptor 是**必要条件**:宿主装 hook 的那一步
 * (`hook-config-service.ts` `ensureHooksInstalled`)按 `hooks.kind` / `scope` 分流 —— `'config'` 的
 * workspace / agent-home 走 `behavior.hooks.writeHooks`,session 由这一家终端腿的会话物化器交付、
 * 写入器不写;`'plugin'` 走 `behavior.plugins.installPlugin`;`'none'` 都不走,
 * `GUGU_HOOK_*` 那组环境变量也就没有任何消费者。descriptor 与实现必须一致(session 那一格由
 * `conformance/session-hooks-conformance.test.ts` 逐家核)。
 */
export function resolveTuiHookReturn(hooks: TuiHooksShape): TuiHookReturn {
  if (hooks.kind === 'none') return { kind: 'absent' };
  return hooks.supportedEvents.includes(TUI_TURN_BOUNDARY_HOOK_EVENT)
    ? { kind: 'installed', events: hooks.supportedEvents }
    : { kind: 'no-turn-boundary', events: hooks.supportedEvents };
}

/** TUI 腿接通时 `observability` 该长的样子 —— 各家不要自己手写这个字面量。 */
export const TUI_HOOK_OBSERVABILITY: SessionCoexistence['observability'] = {
  kind: 'native',
  channel: 'event-stream',
};

/**
 * 由 hooks descriptor 推出这一家 TUI 腿的 `observability` 声明。
 *
 * 没接通时返回 `null` 而不是一个 `none` 值:`null` 的意思是「本模块不替你回答」,让整条维度
 * 落回 `BASE_SESSION_COEXISTENCE`(= 咕咕尚未接通)。❌ 不许在这里造 `unsupported-channel` ——
 * 本仓 grep 不到只能证明咕咕没接,推不出厂商不支持。
 */
export function tuiObservabilityFromHooks(
  hooks: TuiHooksShape
): SessionCoexistence['observability'] | null {
  return resolveTuiHookReturn(hooks).kind === 'installed' ? TUI_HOOK_OBSERVABILITY : null;
}

/** 一次中断要往 pty 写的动作序列(按顺序执行,`delayMs` 是写这一笔**之前**的等待)。 */
export type TuiInterruptWrite = { data: string; delayMs: number };

/**
 * 把中断声明展开成 pty 写入序列。
 *
 * 单独抽出来是为了让「连按几次、隔多久」这件事只有一份实现:宿主那一侧只负责按拍子调
 * `pty.write`,不负责理解某一家的键位语义。
 */
export function tuiInterruptWrites(interrupt: SessionTuiInterrupt): readonly TuiInterruptWrite[] {
  const presses = interrupt.presses ?? 1;
  if (presses < 1) {
    throw new Error(`tui interrupt declares presses=${presses}; must be at least 1`);
  }
  if (presses > 1 && !interrupt.intervalMs) {
    throw new Error('tui interrupt declares presses > 1 but no intervalMs');
  }
  return Array.from({ length: presses }, (_, index) => ({
    data: interrupt.sequence,
    delayMs: index === 0 ? 0 : (interrupt.intervalMs ?? 0),
  }));
}

/** 声明了中断键时 `pause` 该长的样子 —— 各家不要自己手写这个字面量。 */
export const TUI_INTERRUPT_PAUSE: SessionCoexistence['pause'] = {
  kind: 'native',
  channel: 'interrupt-key',
};

/**
 * 由中断键声明推出这一家 TUI 腿的 `pause` 声明。没声明中断键就返回 `null`(落回基类)。
 *
 * ⚠️ **只对 TUI-only 的家成立**。双腿的家(`acp` + `tui`)的 `pause` 记的是 ACP 腿那条
 * 更强的通道(`protocol-cancel`),`UnitDelivery` 一维只能记一个 channel —— 逼它改成
 * `interrupt-key` 是降级。所以对双腿家,中断键这件事只由 `sessionTuiInterrupt` 本身记录,
 * 不反映到 `coexistence.pause` 上。判据见 `tuiInterruptSurfaceRequirement`。
 */
export function tuiPauseFromInterrupt(
  interrupt: SessionTuiInterrupt | undefined,
  surfaces: readonly HarnessSessionSurface[]
): SessionCoexistence['pause'] | null {
  if (!interrupt) return null;
  return surfaces.includes('acp') ? null : TUI_INTERRUPT_PAUSE;
}

/**
 * 中断键的合法性判据 —— **按腿判,不按家判**。
 *
 * 这一条是修一个真 bug,不是重构。上一版的规则是「`pause: interrupt-key` 与 `sessionTuiInterrupt`
 * 必须同生同灭」,双向钉死。听上去很严,实际后果是:19 家双腿的家(`acp` + `tui`)的
 * `pause` 已经是 ACP 腿的 `protocol-cancel`,于是它们**只要声明中断键就当场红** —— 换句话说,
 * 类型系统禁止它们把 TUI 腿的中断键填进来。
 *
 * 而 `ptyController.interrupt`(`apps/desktop/electron/session/main/core/pty/controller.ts:157`)
 * 读的正是 `sessionTuiInterrupt`,读不到就返回 `unsupported`。两条规则合起来的净效果:
 * **32 家有 TUI 腿的家,一家都中断不了自己的 pty**,而其中 19 家的 `pause` 格还是绿的 ——
 * 正是这个类型当初要挡的那个形状(界面报「已暂停」,实际一个字节都没发出去)。
 *
 * 正确的判据是「有没有 pty 可写」—— 只此一处定义在 `declaresSessionTuiLeg`:surfaces 里有 `tui`,
 * **或** `app-server` 那类家在 `sessionpage['tui']` 上挂了终端腿(codex 就是:它的 pty 由 app-server
 * 桥托管,surfaces 里没有独立的 `tui`,但 `ptyController.interrupt` 一样对它写字节)。
 * 上一版只看 surfaces,把 codex 判成「没有 pty」,于是它连中断键都不许声明 —— 手机端按停止
 * 只能得到 `unsupported`(2026-09-15 MBP 矩阵实撞)。
 * - 声明了中断键 ⇒ 必须有可写的 pty(否则字节没有去处);
 * - `pause` 是 `interrupt-key` ⇒ 必须有中断键(channel 点名了机制,没机制就是假声明);
 * - TUI-only 且有中断键 ⇒ `pause` 必须记成 `interrupt-key`(做得到却没声明);
 * - 双腿且有中断键 ⇒ `pause` 保持 ACP 腿的通道,**不**要求同步 —— 这一条是上一版错的地方。
 */
export function tuiInterruptSurfaceRequirement(
  interrupt: SessionTuiInterrupt | undefined,
  descriptor: { surfaces: readonly HarnessSessionSurface[]; sessionpage: Record<string, unknown> }
): 'ok' | 'interrupt-without-tui-leg' {
  if (!interrupt) return 'ok';
  return declaresSessionTuiLeg(descriptor) ? 'ok' : 'interrupt-without-tui-leg';
}

/*
 * `askUser` 在 TUI 腿上**没有**对应的主干 —— 这里不给函数,是结论不是遗漏。
 *
 * 这一维要的是**往返**:agent 抛出一个带选项的问题 → 送到界面 → 用户选 → 答案回到 agent。
 * TUI 腿两头都断:
 * - 去程只有一个**布尔通知**。hook 载荷里能表达的只有 `notification_type`
 *   (`helpers/hooks.ts:118 makeNotificationHookCommand` 只造 `idle_prompt` / `permission_prompt`),
 *   问题正文与选项集全在 pty 的像素里,没有结构化出口。旧枚举值全仓
 *   **零生产者**,只是类型里的一个位置。
 * - 回程没有绑定。`sendInput` 能往 pty 写任意字节,但它写的是**终端**,不是某个待决请求 ——
 *   没有 requestId,答案落在哪一问上无从对账;而同一时刻用户自己也在这个终端里打字。
 *
 * 对照 ACP 腿:`acp-agents/session/cell.ts` 的 requestPermission 生成带 options 的**待决请求**,
 * UI 结算后 resolvePermission 按 id 回填 —— 往返是有主体的。TUI 腿缺的正是这个主体。
 *
 * 所以各家的 `askUser` 一律落回 `BASE_SESSION_COEXISTENCE`。
 * ❌ 不许因为「收得到 permission_prompt 通知」就声明 `permission-ask`:那是单向的「它在等人」,
 * 不是「咕咕问得到、答得回」。
 */
