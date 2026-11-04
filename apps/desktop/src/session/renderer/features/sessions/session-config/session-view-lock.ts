import type { SessionView } from '@shared/core/sessions/sessions';

/**
 * 三种「这一头选不了」,含义各不相同,❌ 别合并成一个布尔:
 * - `general-only`:这一家没有编程视角(会话页不给它终端腿),只能用通用视角(opencode 这一类)。
 * - `general-required-here`:从这里建,这一家的终端腿接不住首句(派进群里的任务没有吃得下任务卡的
 *   启动通道,codex 那一格;判据 `terminalLegUnstartableForCreation`),这一条只能用通用视角;
 *   同一家在别的入口上终端照样可选。
 * - `code-only`:这一家声明了通用视角,但会话页那一面还没接通(身份与投递通道声明仍是 none;
 *   判定在 initial-session-section.tsx),这一条只能用编程视角(kiro 这一类)。
 * - `remote-needs-ssh`:会话页在别的机器上开会话,而那台机器只经云端连着(不是在这台电脑上用 SSH
 *   装上的)—— 编程视角是真终端,要 SSH 直连才有(#6264),这一条只能用通用视角。
 */
export type SessionViewLockReason = 'general-only' | 'general-required-here' | 'code-only' | 'remote-needs-ssh';

/** 被钉在哪一种展示以及为什么(人不再在框里选展示,这份只说这一家这一回实际会开哪种)。`view` 必须等于这条会话真实要开的展示。 */
export type SessionViewLockState = { view: SessionView; reason: SessionViewLockReason };
