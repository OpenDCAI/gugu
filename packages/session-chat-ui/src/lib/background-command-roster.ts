import { runningBackgroundCommands } from '@gugu/session-core/acp/client';
import type { TranscriptTurn } from './../model';

/**
 * 还在跑的**后台命令**花名册(#5117)。
 *
 * # 它和子智能体不是一回事
 *
 * 子智能体由主智能体派出去,派发那次调用本身就是一张卡(见 [[subagent-roster]]),而且
 * 它会把这一轮**挂住**到它跑完(适配器 0.75.1 起的 `deferredSettle`)。
 * 主智能体自己起的后台命令(claude 的 `run_in_background` Bash)三样都不同:
 *   · 它不挂住这一轮 —— 轮当场收口,进程继续跑(2026-09-06 真机:一轮 12 秒收口,
 *     `sleep 3000` 在那之后还活着);
 *   · 它在转录里只是一次普通的工具调用,而那次调用**在派出去那一刻就完成了**;
 *   · 于是屏幕上没有任何东西说「还有东西在跑」,更没有可点的地方把它停下来。
 *
 * ⇒ 判「有没有东西还在跑」不能看调用的 `status`(它早就 completed 了),只能看
 * `backgroundTaskId` 在、而完成通知(`backgroundTaskDone`)还没到。这个判据(连同「重放里的不算在跑」)
 * 在 session-core `runningBackgroundCommands` 一处,会话状态的 park(#6448)读的是同一个 ——
 * 花名册只把它给出的调用写成面板上的行。
 */
export type BackgroundCommandEntry = {
  /** 转录条目 id —— 面板里做 key、也是「不看它了」记的那个 id。 */
  id: string;
  /** 起它那次调用的 tool_use id(转录里那张卡)。 */
  launchToolCallId: string;
  /**
   * 供应商给这个后台任务的 id(`async_task_spawned.asyncTaskId`)—— **停它时报给供应商的是它**,
   * ❌ 不是 tool_use id:0.75.1 的 `_session/async_task/stop` 按 asyncTaskId 找任务,拿 tool_use id
   * 去停只会得到 `{stopped:false}`(#5117)。
   */
  taskId: string;
  /** 它在干什么(那次调用的标题);一个字都没给才退到通用词,❌ 不编。 */
  name: string;
  /** 起它那次调用的时刻(毫秒);拿不到就没有 —— 那就不画时长,❌ 编一个。 */
  startedAt?: number;
};

/**
 * 运行时说「本进程里还在跑」的那些任务 id(`sessionState.backgroundCommandTaskIds`),给花名册做筛子(#6582)。
 *
 * 为什么要筛:面板读的转录一部分是**库里**的旧轮,带着 `startedAt`、看上去像活的,而起它们的那个进程
 * 可能已经没了(重启、worker 重启、空闲回收)——命令随进程没了,终态永远不会来,卡就永远「在跑」。
 * 哪些命令真活着,只有运行时知道;它用的是同一个 `runningBackgroundCommands`(park 与空闲回收读的也是它)。
 *
 * - 会话不在(还没连上 / lost / closed):`[]` —— 没有活着的进程,就没有在跑的命令;
 * - 对面没报这一格(旧运行时):`null` = 不知道、不过滤,保持旧行为。❌ 当成 `[]`:那会藏掉真在跑的卡。
 */
export function runningBackgroundTaskIds(
  state: { lifecycle: string; backgroundCommandTaskIds?: readonly string[] } | null | undefined
): readonly string[] | null {
  if (!state || state.lifecycle === 'lost' || state.lifecycle === 'closed') return [];
  return state.backgroundCommandTaskIds ?? null;
}

export function collectBackgroundCommandRoster(
  turns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  /** 一个字都没给时的通用词(调用方给,好过在这儿编)。 */
  fallbackName: string,
  /** `runningBackgroundTaskIds` 的结果:数组 ⇒ 只留运行时也说在跑的;`null` ⇒ 不筛(旧运行时)。 */
  runningTaskIds: readonly string[] | null
): BackgroundCommandEntry[] {
  const running = runningBackgroundCommands(turns, activeTurn);
  const live = runningTaskIds === null ? running : running.filter((node) => runningTaskIds.includes(node.backgroundTaskId));
  return live.map((node) => {
    const title = node.title.trim();
    return {
      id: node.id,
      launchToolCallId: node.toolCallId,
      taskId: node.backgroundTaskId,
      name: title === '' ? fallbackName : title,
      ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
    };
  });
}
