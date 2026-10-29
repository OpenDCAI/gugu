/**
 * 终端腿的 harness 有没有接住首句(owner 10-28,Linux 2 的 e4e174ec):任务带着首句起了 pty,之后一条 hook 都没来,
 * 也没有一行会话记录 —— 界面只在下一次打开时说「找不到会话记录」,当时终端里到底是什么已经没人知道。
 *
 * 起的时候带了首句、而这一家报得出回合开始(`start` hook)⇒ 首句一进去就该有 hook 回来。`withinMs` 内这一发一条都没
 * 来、pty 还在 ⇒ 把屏上最后几十行(去掉疑似密钥)记进日志,并经起失败那条账本在会话页说出来,带上那几行。
 * 来了任何一条、或者 pty 先退了(退出那条路自己会说)⇒ 什么都不做。
 */
export const FIRST_TURN_WITHIN_MS = 20_000;
export const SCREEN_LINES = 40;

/** 疑似密钥的长串换成 `[redacted]`:令牌、key、Bearer 后面那段。屏上只留人看得见的字,❌ 原样把凭据写进日志。 */
export function redactScreenLine(line: string): string {
  return line
    .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]');
}

export function watchFirstTurnTaken(input: {
  /** 这一发 spawn 的 hook 来了任何一条:调 `heard()`。返回取消订阅。 */
  onHook: (heard: () => void) => () => void;
  /** pty 还在不在。 */
  alive: () => boolean;
  screenText: () => Promise<string[]>;
  report: (failure: { lines: string[]; alive: boolean }) => void;
  withinMs?: number;
}): () => void {
  let done = false;
  const stopHook = input.onHook(() => {
    done = true;
  });
  const timer = setTimeout(() => {
    stopHook();
    if (done || !input.alive()) return;
    done = true;
    void input
      .screenText()
      .catch(() => [] as string[])
      .then((lines) => input.report({ lines: lines.map(redactScreenLine), alive: input.alive() }));
  }, input.withinMs ?? FIRST_TURN_WITHIN_MS);
  timer.unref?.();
  return () => {
    done = true;
    clearTimeout(timer);
    stopHook();
  };
}

/**
 * 会话页上那句话(起失败账本里显示的原文):说清是终端里的 harness 没接住首句。会话页只显示第一行(safeFailureLine),
 * 所以屏上最后两行有字的接在第一行里;整屏那几行跟在后面(日志、别的读者)。
 */
export function firstTurnNotTakenMessage(providerName: string, lines: readonly string[], withinMs = FIRST_TURN_WITHIN_MS): string {
  const head = `${providerName} in the terminal did not take the first message within ${Math.round(withinMs / 1000)} s.`;
  const shown = lines.map((line) => line.trim()).filter(Boolean);
  if (!shown.length) return `${head} Its screen was empty.`;
  return `${head} Its screen ends with: "${shown.slice(-2).join(' / ')}"\n${lines.join('\n')}`;
}
