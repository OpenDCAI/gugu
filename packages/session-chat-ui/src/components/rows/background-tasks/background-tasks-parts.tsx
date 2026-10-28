/** @jsxImportSource solid-js */
/**
 * 后台任务那一句和它展开的单子 —— 两处共用:挂在末尾那条回复的过程行上(`ConversationMessage`),
 * 或者没有可挂的回复时单独一行贴在列表最后(`background-tasks.def.tsx`)。
 *
 * 画法沿用原来「输出」卡里后台命令 / 子智能体那两节(同一套密度面板、同一套图标和措辞),只是从浮层挪进了列表。
 */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconSquareTerminal, IconStop, IconUser, IconX } from '@session-chat/components/primitives/icons';
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import type { SubagentRosterEntry } from '@session-chat/lib/subagent-roster';
import { useChatTranslator, type ChatTranslator } from '@session-chat/localization';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  backgroundTaskButton,
  backgroundTaskDismiss,
  backgroundTaskIcon,
  backgroundTaskMeta,
  backgroundTaskName,
  backgroundTaskRow,
  backgroundTasksList,
  backgroundTaskStop,
} from './background-tasks.css';

/** 单子里一行的高(4 + 20 + 4)、行距、单子的内距、单子与上面那一行之间的空。 */
export const BACKGROUND_TASK_ROW_H = 28;
const ROW_GAP = 4;
const LIST_PAD = 4;
const LIST_TOP = 4;

export function backgroundTasksListHeight(count: number): number {
  if (count === 0) return 0;
  return LIST_TOP + LIST_PAD * 2 + count * BACKGROUND_TASK_ROW_H + (count - 1) * ROW_GAP;
}

/** 「后台 · 2 条命令 · 1 个子智能体」。 */
export function backgroundTasksLabel(
  translate: ChatTranslator,
  commandCount: number,
  agentCount: number
): string {
  const parts: string[] = [];
  if (commandCount > 0)
    parts.push(translate(commandCount === 1 ? 'transcript.backgroundTasks.commandsOne' : 'transcript.backgroundTasks.commands', { count: commandCount }));
  if (agentCount > 0)
    parts.push(translate(agentCount === 1 ? 'transcript.backgroundTasks.subagentsOne' : 'transcript.backgroundTasks.subagents', { count: agentCount }));
  return translate('transcript.backgroundTasks.label', { parts: parts.join(' · ') });
}

/** 展开的单子:一行一个任务 —— 图标、名字、(子智能体)步数与时长、停止、×(只收起,❌ 不停)。 */
export function BackgroundTasksList(props: {
  commands: readonly BackgroundCommandEntry[];
  subagents: readonly SubagentRosterEntry[];
}) {
  const translate = useChatTranslator();
  const commands = useCommands();

  // 单子挂着才数秒:收着时屏上没有跟着时间走的数(与原来那张卡「开着才跳」同一条)。
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  // 后台命令不画时长:它的起点没记在调用上,❌ 为了对称编一个(原来那张卡同一条)。
  const elapsed = (startedAt?: number): string =>
    startedAt === undefined ? '' : formatElapsed(Math.max(0, now() - startedAt));

  const stop = (event: MouseEvent, stopId: string): void => {
    event.stopPropagation();
    commands().onStopBackgroundTask?.({ stopId });
  };
  const dismiss = (event: MouseEvent, entryId: string): void => {
    event.stopPropagation();
    commands().onDismissBackgroundTask?.({ entryId });
  };
  const DismissButton = (p: { entryId: string }) => (
    <Show when={commands().onDismissBackgroundTask}>
      <button
        type="button"
        class={`${backgroundTaskButton} ${backgroundTaskDismiss}`}
        title={translate('transcript.backgroundTasks.dismiss')}
        aria-label={translate('transcript.backgroundTasks.dismiss')}
        onClick={(event) => dismiss(event, p.entryId)}
      >
        <IconX />
      </button>
    </Show>
  );

  return (
    <div class={backgroundTasksList} style={{ 'margin-top': `${LIST_TOP}px` }} data-slot="background-tasks-list">
      <For each={props.commands}>
        {(command) => (
          <div class={backgroundTaskRow} data-slot="background-task" data-task-kind="command" title={command.name}>
            <span class={backgroundTaskIcon}>
              <IconSquareTerminal />
            </span>
            <span class={backgroundTaskName}>{command.name}</span>
            <Show when={commands().onStopBackgroundTask}>
              <button
                type="button"
                class={`${backgroundTaskButton} ${backgroundTaskStop}`}
                title={translate('transcript.backgroundTasks.stopCommand')}
                aria-label={translate('transcript.backgroundTasks.stopCommand')}
                onClick={(event) => stop(event, command.taskId)}
              >
                <IconStop />
              </button>
            </Show>
            <DismissButton entryId={command.id} />
          </div>
        )}
      </For>
      <For each={props.subagents}>
        {(agent) => (
          <div class={backgroundTaskRow} data-slot="background-task" data-task-kind="subagent" title={agent.name}>
            <span class={backgroundTaskIcon}>
              <IconUser />
            </span>
            <span class={backgroundTaskName}>{agent.name}</span>
            <span class={backgroundTaskMeta}>
              {[
                agent.completedSteps > 0
                  ? translate(agent.completedSteps === 1 ? 'transcript.backgroundTasks.stepsOne' : 'transcript.backgroundTasks.steps', { count: agent.completedSteps })
                  : '',
                elapsed(agent.startedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Show when={agent.canCancel && commands().onStopBackgroundTask}>
              <button
                type="button"
                class={`${backgroundTaskButton} ${backgroundTaskStop}`}
                title={translate('transcript.backgroundTasks.stopSubagent')}
                aria-label={translate('transcript.backgroundTasks.stopSubagent')}
                onClick={(event) => stop(event, agent.launchToolCallId)}
              >
                <IconStop />
              </button>
            </Show>
            <DismissButton entryId={agent.id} />
          </div>
        )}
      </For>
    </div>
  );
}
