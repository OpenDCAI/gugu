import { log } from './logger';

/**
 * #4320 —— 一条链路的分段账本。
 *
 * 为什么需要它，而不是像 #4181 那样在每个文件里手写一个 `mark()`：
 * **这一半的日志默认看不见。** 会话页这半边的 logger 默认级别是 `warn`
 * （`@gugu/session-shared/logger` 的 `resolveLogLevel`：没有 `GUGU_SESSION_LOG_LEVEL`/`LOG_LEVEL`、
 * 没有 `--debug-logs` 就是 `warn`），落的又是另一个文件 `gugu-task.log`；而 gugu 宿主那半边默认 `debug`、
 * 落 `gugu-main.log`。所以 owner 拿回来的 `gugu-main.log` 里，spawn 与 ACP 启动这两段**结构上不可能出现**——
 * 那正是 #4320 里两段「空白」的由来，不是它们没发生。
 *
 * ⇒ 分段账本给两种读者各留一条路：
 *   · 逐段 `info`：把级别调高（`GUGU_SESSION_LOG_LEVEL=info`）就能看全过程，开发期用；
 *   · **超预算一条 `warn`**：把整份分段耗时打包成一行，默认级别下也一定落盘 ——
 *     下一次「卡住了」的日志送回来时，慢在哪一段已经写在里面，不必再让人复现一遍。
 *
 * ❌ 不把逐段日志直接提到 warn：正常启动每次刷十几行 warn，等于把这条通道变成噪音，
 * 下次真出事时没人看得见。慢才说话，是这条账本的全部意义。
 */
export interface StageLedger {
  /** 记一段完成。`extra` 里的字段随这一段落盘。 */
  mark(stage: string, extra?: Record<string, unknown>): void;
  /** 链路收尾。总耗时超过预算时打一行 warn，带上完整分段与最慢的那一段。 */
  settle(extra?: Record<string, unknown>): void;
  /** 已经走过的毫秒数（调用方要把它写进自己的字段时用）。 */
  elapsedMs(): number;
}

export function createStageLedger(input: {
  /** 责任域 scope（diagnostic-logging：可归因事件用职责域 scope，标识放字段里）。 */
  scope: string;
  /** 这条链路是什么，进消息文本。 */
  what: string;
  /** 每行都带的可查询标识。 */
  fields: Record<string, unknown>;
  /** 超过它就把整份分段以 warn 打出来。 */
  budgetMs: number;
  now?: () => number;
}): StageLedger {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const stages: Array<{ stage: string; atMs: number }> = [];
  let settled = false;
  return {
    elapsedMs: () => now() - startedAt,
    mark(stage, extra) {
      const atMs = now() - startedAt;
      stages.push({ stage, atMs });
      log.info(`${input.what} stage — #4320`, {
        scope: input.scope,
        ...input.fields,
        stage,
        elapsedMs: atMs,
        ...extra,
      });
    },
    settle(extra) {
      if (settled) return;
      settled = true;
      const totalMs = now() - startedAt;
      if (totalMs <= input.budgetMs) return;
      // 分段耗时 = 相邻两个 mark 的差；最后一段量到 settle 为止，慢在收尾也跑不掉。
      let previousAtMs = 0;
      const breakdown = [...stages, { stage: 'settle', atMs: totalMs }].map((entry) => {
        const tookMs = entry.atMs - previousAtMs;
        previousAtMs = entry.atMs;
        return { stage: entry.stage, tookMs };
      });
      const slowest = breakdown.reduce(
        (worst, entry) => (entry.tookMs > worst.tookMs ? entry : worst),
        { stage: 'none', tookMs: -1 },
      );
      log.warn(`${input.what} exceeded ${Math.round(input.budgetMs / 1000)}s — #4320`, {
        scope: input.scope,
        ...input.fields,
        totalMs,
        budgetMs: input.budgetMs,
        slowestStage: slowest.stage,
        slowestMs: slowest.tookMs,
        breakdown,
        ...extra,
      });
    },
  };
}
