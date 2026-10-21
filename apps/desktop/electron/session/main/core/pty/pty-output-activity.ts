import type { Pty } from './pty';

/**
 * @@@pty-output-activity(#5558) —— 「这条 PTY 出过字没有、最后一个字节是什么时候」这个事实的家。
 *
 * **写入者只有一个**:`pty-session-registry.ts` 的 `register()` 里那个 `pty.onData` —— 它是从
 * `spawnLocalPty()` **同一个同步回合**里挂上的(`local-session.ts` 里 spawn 与 register 之间
 * 成功路上没有任何 `await`;`spawnLocalPty` 自己也全同步)⇒ 它看得见整条流的第一个字节。
 *
 * ⚠️ **为什么这个事实必须存在、而不是让读者自己去看** ——
 * 一个**后挂**的观察者,历史是空的:它分不清「这条 PTY 从没出过字」和「出过,但在我挂上之前」。
 * 注入器的就绪闸从前正是这么写的(到了消息才挂 `onData`),于是一条**早就画完、正停在输入框等输入**
 * 的会话在它眼里等于「从没静过」,只能等满 `MAX_WAIT_MS`(实测 15 348ms,#5558)。
 * ⇒ 读者一律**读**这里,❌ 不许再另挂一个 `onData` 去数同一件事。
 */
type PtyOutputActivity = {
  /** 最后一个字节到达的时刻。记录存在本身 = 这条 PTY 出过字。 */
  readonly lastDataAt: number;
};

const activityByPty = new WeakMap<Pty, { lastDataAt: number }>();

/** 唯一的写入口 —— 只有 registry 那个 onData 该调它。 */
export function recordPtyOutput(pty: Pty, at: number = Date.now()): void {
  const existing = activityByPty.get(pty);
  if (existing) existing.lastDataAt = at;
  else activityByPty.set(pty, { lastDataAt: at });
}

/**
 * 这条 PTY 的输出活动事实。`null` = **这条 PTY 一个字节都没出过**(不是「没人看」——
 * 写入者从 spawn 那一刻就在看了)。
 */
export function ptyOutputActivity(pty: Pty): PtyOutputActivity | null {
  return activityByPty.get(pty) ?? null;
}

/**
 * 流结束了 ⇒ 这条事实作废。调用者只有 registry 的 `pty.onExit`。
 * (「它在 T 时刻出过字」死后仍然为真,但**据此推断「现在可以往里写」不再成立** ——
 *  作废掉,比让读者各自记住「还要额外看它死没死」诚实。)
 */
export function forgetPtyOutput(pty: Pty): void {
  activityByPty.delete(pty);
}
