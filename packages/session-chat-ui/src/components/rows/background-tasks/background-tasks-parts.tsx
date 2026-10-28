/** @jsxImportSource solid-js */
/**
 * 后台任务那一句和它展开的单子 —— 两处共用:挂在末尾那条回复的过程行上(`ConversationMessage`),
 * 或者没有可挂的回复时单独一行贴在列表最后(`background-tasks.def.tsx`)。
 *
 * 画法沿用原来「输出」卡里后台命令 / 子智能体那两节(同一套密度面板、同一套图标和措辞),只是从浮层挪进了列表。
 */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { GridLoader } from '@session-chat/components/primitives/GridLoader';
import { IconCheck, IconSquareTerminal, IconStop, IconUser, IconX } from '@session-chat/components/primitives/icons';
import type { BackgroundCommandEntry } from '@session-chat/lib/background-command-roster';
import { formatElapsed } from '@session-chat/lib/format-elapsed';
import type { SubagentRosterEntry } from '@session-chat/lib/subagent-roster';
import { useChatTranslator, type ChatTranslator } from '@session-chat/localization';
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  backgroundTaskButton,
  backgroundTaskDismiss,
  backgroundTaskIcon,
  backgroundTaskMeta,
  backgroundTaskName,
  backgroundTaskRow,
  backgroundTasksList,
  backgroundTaskStop,
  subagentPanel,
  subagentPanelElapsed,
  subagentPanelEmpty,
  subagentPanelMeta,
  subagentPanelModel,
  subagentPanelName,
  subagentTimeline,
  subagentTimelineErrorDot,
  subagentTimelineMarker,
  subagentTimelineStep,
  subagentTimelineTitle,
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

/** 悬停开 / 离开关的延时(原来摘要卡同一对):扫过去不闪,从行挪到浮层上的那一下不关。 */
const OPEN_DELAY_MS = 220;
const CLOSE_DELAY_MS = 160;
/** 浮层与行之间的空、与窗口边的最小距离、浮层宽(= css 里的 320)。 */
const PANEL_GAP = 6;
const VIEWPORT_PAD = 8;
const PANEL_W = 320;

/**
 * 浮层贴在行下方、左对齐;下面放不下就翻到行上方,两边都放不下贴着窗口底;左右夹在窗口里。
 * 纯函数,便于单测 —— 量好的矩形进、`top/left` 出。
 */
export function placeSubagentPanel(
  anchor: { top: number; bottom: number; left: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number } {
  const below = anchor.bottom + PANEL_GAP;
  const above = anchor.top - PANEL_GAP - panel.height;
  let top: number;
  if (below + panel.height <= viewport.height - VIEWPORT_PAD) top = below;
  else if (above >= VIEWPORT_PAD) top = above;
  else top = Math.max(VIEWPORT_PAD, viewport.height - VIEWPORT_PAD - panel.height);
  const left = Math.max(VIEWPORT_PAD, Math.min(anchor.left, viewport.width - VIEWPORT_PAD - panel.width));
  return { top, left };
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

  // 悬停子智能体那一行 → 它的工具时间线。状态按 id 记在单子上,❌ 记在行里:名单每来一次更新条目都是新对象,
  // <For> 会把行换掉,记在行里浮层就跟着每次更新闪一下。
  const anchors = new Map<string, HTMLElement>();
  const [hoveredId, setHoveredId] = createSignal<string | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (id: string | null, delay: number): void => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setHoveredId(id), delay);
  };
  onCleanup(() => clearTimeout(hoverTimer));
  const hovered = createMemo(() => {
    const id = hoveredId();
    return id === null ? undefined : props.subagents.find((agent) => agent.id === id);
  });

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
          // ❌ 原生 title:悬停已经弹出写全名字的浮层,再叠一个系统提示会盖在它上面(原卡同一条)。
          <div
            ref={(el) => anchors.set(agent.id, el)}
            class={backgroundTaskRow}
            data-slot="background-task"
            data-task-kind="subagent"
            onMouseEnter={() => schedule(agent.id, hoveredId() === null ? OPEN_DELAY_MS : 0)}
            onMouseLeave={() => schedule(null, CLOSE_DELAY_MS)}
          >
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
      <Show when={hovered()}>
        {(agent) => (
          <SubagentPanel
            agent={agent()}
            anchor={() => anchors.get(agent().id)}
            elapsed={agent().startedAt === undefined ? formatElapsed(agent().elapsedMs) : elapsed(agent().startedAt)}
            onEnter={() => schedule(agent().id, 0)}
            onLeave={() => schedule(null, CLOSE_DELAY_MS)}
          />
        )}
      </Show>
    </div>
  );
}

/**
 * 子智能体的浮层:名字、模型与时长、它自己跑过的每一步(原来摘要卡里那张,停止与 × 已经长在行上,这里不再重复)。
 *
 * ⚠️ 这些调用**不**在主消息列表里出现,这儿是唯一能看到它们的地方 —— ❌ 嫌长截掉几条,太长给滚动。
 *
 * portal 到 `[data-chat-root]`:它带着宿主给的字号变量(inline)和主题类的继承;它自己没有 transform / contain,
 * 所以里面的 position: fixed 按窗口算,不被行或根的 overflow 裁。
 */
function SubagentPanel(props: {
  agent: SubagentRosterEntry;
  anchor: () => HTMLElement | undefined;
  elapsed: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const translate = useChatTranslator();
  const [pos, setPos] = createSignal<{ top: number; left: number } | null>(null);
  let panelEl: HTMLDivElement | undefined;

  const place = (): void => {
    const anchor = props.anchor();
    if (!anchor || !panelEl || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    setPos(
      placeSubagentPanel(
        rect,
        { width: panelEl.offsetWidth || PANEL_W, height: panelEl.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  };
  // 步数变了浮层会长高,重新放一次;滚动(行跟着虚拟列表挪)与窗口变化也一样。
  createEffect(() => {
    void props.agent.calls.length;
    void props.agent.id;
    place();
  });
  const onScrollOrResize = (): void => place();
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  onCleanup(() => {
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize);
  });

  const mount = (): Node => props.anchor()?.closest('[data-chat-root]') ?? document.body;

  return (
    <Portal mount={mount()}>
      <div
        ref={(el) => {
          panelEl = el;
          queueMicrotask(place);
        }}
        class={subagentPanel}
        data-slot="subagent-hover-panel"
        style={{
          top: `${pos()?.top ?? 0}px`,
          left: `${pos()?.left ?? 0}px`,
          // 量好位置之前先不露:第一帧在 (0,0) 闪一下。
          visibility: pos() ? 'visible' : 'hidden',
        }}
        onMouseEnter={() => props.onEnter()}
        onMouseLeave={() => props.onLeave()}
      >
        <span class={subagentPanelName}>{props.agent.name}</span>
        <div class={subagentPanelMeta}>
          <Show when={props.agent.model}>
            <span class={subagentPanelModel}>{props.agent.model}</span>
          </Show>
          <span class={subagentPanelElapsed}>{props.elapsed}</span>
        </div>
        <Show
          when={props.agent.calls.length > 0}
          fallback={<span class={subagentPanelEmpty}>{translate('transcript.backgroundTasks.noSteps')}</span>}
        >
          <div class={subagentTimeline} data-slot="subagent-timeline">
            <For each={props.agent.calls}>
              {(call) => (
                <div class={subagentTimelineStep} data-slot="subagent-timeline-step" data-status={call.status}>
                  <span class={subagentTimelineMarker} data-status={call.status}>
                    <Switch fallback={<GridLoader />}>
                      <Match when={call.status === 'done'}>
                        <IconCheck />
                      </Match>
                      <Match when={call.status === 'error'}>
                        <span class={subagentTimelineErrorDot} />
                      </Match>
                    </Switch>
                  </span>
                  <span class={subagentTimelineTitle}>{call.title}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Portal>
  );
}
