import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Square, X } from '@/lib/icons'
import {
  collectBackgroundCommandRoster,
  type BackgroundCommandEntry,
} from '@gugu/session-chat-ui';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isSubagentDismissed } from './subagent-dismissals';

/**
 * 「输出/来源」面板里的**后台命令**一节(#5117)。
 *
 * owner 2026-09-06:「不能让子智能体 runback,得主智能体创建 background_command」——
 * 也就是说,真正会在屏幕上没人管地一直跑下去的,是主智能体自己起的后台命令。子智能体
 * 会把这一轮挂住到它跑完,而后台命令不会:轮当场收口,进程照跑(真机实测一轮 12 秒收口、
 * `sleep 3000` 之后还活着),转录里那次调用也早就 completed 了 ⇒ 屏幕上没有任何东西
 * 说「还有东西在跑」。这一节就是那个「有」,以及唯一能把它停下来的地方。
 *
 * 画法跟着隔壁子智能体那节走(同一套密度面板、同一套字号 —— 2026-09-22 两处一起按
 * design.md 从「逐行 `paper` 卡」改成「外层 `bg-background-1` + 逐行 hover」,见
 * session-subagents-section.tsx 顶部注),两处刻意不同:
 *   1. 不画步数/时长:后台命令没有「步」,起点也没记在条目上 —— ❌ 不为了对称编两个格子;
 *   2. 停止键长在卡面上、不藏在悬浮面板里:那张卡只有一行字,没有要悬浮才看得见的细节,
 *      而这颗键是这一节存在的理由。
 */
export function collectBackgroundCommands(
  sessionId: string | undefined,
  fallbackName: string
): BackgroundCommandEntry[] {
  if (!sessionId) return [];
  const store = findAcpChatStore(sessionId);
  if (!store) return [];
  // mobx 依赖:与 collectSubagents 同一条(调用方必须在 observer 里)。
  void store.messageCount;
  const transcript = store.chatState.transcript.state;
  return collectBackgroundCommandRoster(
    transcript.committedTurns,
    transcript.activeTurnSnapshot,
    fallbackName,
    // 库里读出来的旧轮可能是上一个进程起的命令,随进程没了、永远等不来终态 —— 只留运行时说还在跑的(#6582)。
    store.runningBackgroundTaskIds
    // 「我不看它了」是显示层的事,与子智能体共用同一张收起表(键里带条目 id)。
  ).filter((entry) => !isSubagentDismissed(sessionId, entry.id));
}

export function SessionBackgroundCommandsSection({
  commands,
  onDismiss,
  onStop,
}: {
  commands: readonly BackgroundCommandEntry[];
  /** 只把这张卡收起 —— ❌ 不动那条命令,它照旧在跑。 */
  onDismiss: (entryId: string) => void;
  /** 真把它停掉:传起它那次调用的 tool_use id,一路到适配器 `_session/async_task/stop`。 */
  /** 收到的是供应商的后台任务 id,停止走 `_session/async_task/stop` 要的就是它(#5117)。 */
  onStop: (backgroundTaskId: string) => void;
}) {
  const { translate } = useSessionMessages();
  // 一条在跑的都没有 ⇒ 整节不画(与子智能体那节同一条:❌ 不留空位)。
  if (commands.length === 0) return null;

  return (
    <>
      <div className="px-2 text-xs font-medium text-foreground-muted">
        {translate('task.backgroundCommands')}
      </div>
      <div
        data-slot="background-command-list"
        className="flex max-h-64 w-full flex-col gap-1 overflow-y-auto rounded-lg bg-background-1 p-1"
      >
        {commands.map((command) => (
          <div
            key={command.id}
            data-slot="background-command-card"
            className="hover:bg-row-hover flex items-center gap-2 rounded-sm px-2 py-1"
          >
            <LoadingIndicator size="inline" className="shrink-0 text-foreground/35" />
            <span className="flex-1 truncate text-sm" title={command.name}>
              {command.name}
            </span>
            {/* 停它。按下去卡还在就是还没停 —— 停成了供应商回一条通知,转录那一行落定、
                这张卡随之撤下,❌ 这里不预演结果。 */}
            <button
              type="button"
              data-slot="background-command-stop"
              aria-label={translate('task.backgroundCommandStop')}
              title={translate('task.backgroundCommandStop')}
              onClick={() => onStop(command.taskId)}
              className="shrink-0 rounded-sm p-1 text-foreground/35 transition-colors hover:text-destructive"
            >
              {/* 实心方块:空心的看着像没勾的复选框(owner 2026-09-06)。 */}
              <Square className="size-3 [&_path]:fill-current" />
            </button>
            <button
              type="button"
              data-slot="background-command-dismiss"
              aria-label={translate('task.backgroundCommandDismiss')}
              title={translate('task.backgroundCommandDismiss')}
              onClick={() => onDismiss(command.id)}
              className="shrink-0 rounded-sm p-1 text-foreground/35 transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
