/** @jsxImportSource solid-js */
/**
 * background-tasks —— 还在跑的后台命令与子智能体,贴在消息列表最后一行。
 *
 * owner 2026-10-27:右上角「摘要」按钮和它那张卡去掉,后台任务直接放进主对话。收着时就是一句
 * 「后台 · 2 条命令 · 1 个子智能体 ›」(带微光:有东西在动);点开就地展开成一张单子,一行一个任务:
 * 图标、名字、(子智能体)走到第几步与跑了多久、停止、×(只收起,❌ 不停)。后台命令不画时长:它的起点没记在调用上,
 * ❌ 为了对称编一个(原来那张卡同一条)。
 *
 * 画法沿用原来「输出」卡里后台命令 / 子智能体那两节(同一套密度面板、同一套图标和措辞),只是从浮层挪进了列表。
 *
 * 单子展开会让这一行长高 ⇒ measure 按条目数算;开关走 ChatRoot 既有的 `data-collapse-id` 点击委派
 * (`BACKGROUND_TASKS_TOGGLE`),❌ 自己再挂一套开合状态。
 */
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { IconSquareTerminal, IconStop, IconUser, IconX } from '@session-chat/components/primitives/icons';
import { defineUnit } from '@session-chat/core/units';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import { useChatTranslator } from '@session-chat/localization';
import type { BackgroundTasksItem } from '@session-chat/model';
import { BACKGROUND_TASKS_TOGGLE } from '@session-chat/state/flatten';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  backgroundTaskButton,
  backgroundTaskDismiss,
  backgroundTaskIcon,
  backgroundTaskMeta,
  backgroundTaskName,
  backgroundTaskRow,
  backgroundTasksList,
  backgroundTasksRow,
  backgroundTaskStop,
} from './background-tasks.css';

/** 单子里一行的高(4 + 20 + 4)、行距、单子的内距、单子与头之间的空。 */
export const BACKGROUND_TASK_ROW_H = 28;
const ROW_GAP = 4;
const LIST_PAD = 4;
const LIST_TOP = 4;

export function backgroundTasksListHeight(count: number): number {
  if (count === 0) return 0;
  return LIST_TOP + LIST_PAD * 2 + count * BACKGROUND_TASK_ROW_H + (count - 1) * ROW_GAP;
}

export const backgroundTasksUnitDef = defineUnit<BackgroundTasksItem, { extraH: number }>({
  kind: 'background-tasks',
  margin: { top: 4, bottom: 12 },
  vars: { extraH: HEADER_ROW_EXTRA_H },

  measure(data, ctx, vars_) {
    const head = ctx.theme.fonts.body.lineHeight + vars_.extraH;
    return head + (data.expanded ? backgroundTasksListHeight(data.commands.length + data.subagents.length) : 0);
  },

  Render(props) {
    const translate = useChatTranslator();
    const commands = useCommands();
    const theme = useTheme();
    const headH = () => theme().fonts.body.lineHeight + props.vars.extraH;

    // 单子开着才数秒:收着时屏上没有跟着时间走的数(与原来那张卡「开着才跳」同一条)。
    const [now, setNow] = createSignal(Date.now());
    createEffect(() => {
      if (!props.data.expanded) return;
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    const elapsed = (startedAt?: number): string =>
      startedAt === undefined ? '' : formatElapsed(Math.max(0, now() - startedAt));

    const label = (): string => {
      const parts: string[] = [];
      const commandCount = props.data.commands.length;
      const agentCount = props.data.subagents.length;
      if (commandCount > 0)
        parts.push(translate(commandCount === 1 ? 'transcript.backgroundTasks.commandsOne' : 'transcript.backgroundTasks.commands', { count: commandCount }));
      if (agentCount > 0)
        parts.push(translate(agentCount === 1 ? 'transcript.backgroundTasks.subagentsOne' : 'transcript.backgroundTasks.subagents', { count: agentCount }));
      return translate('transcript.backgroundTasks.label', { parts: parts.join(' · ') });
    };

    const stop = (event: MouseEvent, stopId: string): void => {
      event.stopPropagation();
      commands().onStopBackgroundTask?.({ stopId });
    };
    const dismiss = (event: MouseEvent, entryId: string): void => {
      event.stopPropagation();
      commands().onDismissBackgroundTask?.({ entryId });
    };

    return (
      <div data-slot="background-tasks" class={backgroundTasksRow}>
        <CollapseHeader id={BACKGROUND_TASKS_TOGGLE} collapsible expanded={props.data.expanded} active height={headH()}>
          {label()}
        </CollapseHeader>
        <Show when={props.data.expanded}>
          <div class={backgroundTasksList} style={{ 'margin-top': `${LIST_TOP}px` }} data-slot="background-tasks-list">
            <For each={props.data.commands}>
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
                  <Show when={commands().onDismissBackgroundTask}>
                    <button
                      type="button"
                      class={`${backgroundTaskButton} ${backgroundTaskDismiss}`}
                      title={translate('transcript.backgroundTasks.dismiss')}
                      aria-label={translate('transcript.backgroundTasks.dismiss')}
                      onClick={(event) => dismiss(event, command.id)}
                    >
                      <IconX />
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <For each={props.data.subagents}>
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
                  <Show when={commands().onDismissBackgroundTask}>
                    <button
                      type="button"
                      class={`${backgroundTaskButton} ${backgroundTaskDismiss}`}
                      title={translate('transcript.backgroundTasks.dismiss')}
                      aria-label={translate('transcript.backgroundTasks.dismiss')}
                      onClick={(event) => dismiss(event, agent.id)}
                    >
                      <IconX />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  },
});
