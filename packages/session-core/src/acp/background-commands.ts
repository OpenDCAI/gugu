import type { ToolCallItem, TranscriptItem, TranscriptTurn } from './models/turns';

/**
 * 还在跑的后台命令(claude 的 `run_in_background` Bash、workflow)。派发调用当场就 completed 了,
 * 「还在跑」= 卡上有 `backgroundTaskId`、完成通知(`backgroundTaskDone`)还没到。子智能体不在此列。
 * 摘要栏花名册与会话状态(park)读同一个判据。
 *
 * 重放里的不算在跑:resume 起的是新进程,上一个进程的后台命令没跟过来。没有 `startedAt` 的一轮是重放出来的。
 */
export type RunningBackgroundCommand = ToolCallItem & { backgroundTaskId: string };

type BackgroundNode = ToolCallItem & { backgroundTaskId: string };

function walk(items: readonly TranscriptItem[], out: BackgroundNode[]): void {
  for (const item of items) {
    if (item.kind === 'tool-group') {
      // read-batch 那层壳没有 `toolCallId` —— 它是排版不是调用,只往里找。
      walk(item.children, out);
      continue;
    }
    if (!('toolCallId' in item)) continue;
    if (typeof item.backgroundTaskId === 'string') out.push(item as BackgroundNode);
    if (item.children) walk(item.children, out);
  }
}

export function runningBackgroundCommands(
  turns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null
): RunningBackgroundCommand[] {
  const found: BackgroundNode[] = [];
  const replayed = new Set<string>();
  const scan = (turn: TranscriptTurn): void => {
    const before = found.length;
    walk(turn.items, found);
    if (turn.startedAt !== undefined) return;
    for (let i = before; i < found.length; i++) replayed.add(found[i].toolCallId);
  };
  for (const turn of turns) scan(turn);
  if (activeTurn) scan(activeTurn);

  const byCallId = new Map<string, RunningBackgroundCommand>();
  for (const node of found) {
    if (node.backgroundTaskDone === true) {
      // 跑完(或被停)了 —— 已经收进来的同一次调用要撤掉:同一条调用会来好几条更新,
      // 完成那条不一定是最后遍历到的。
      byCallId.delete(node.toolCallId);
      continue;
    }
    if (replayed.has(node.toolCallId)) continue;
    byCallId.set(node.toolCallId, node);
  }
  return [...byCallId.values()];
}
