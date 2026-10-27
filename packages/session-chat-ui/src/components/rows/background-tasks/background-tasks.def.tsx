/** @jsxImportSource solid-js */
/**
 * background-tasks —— 还在跑的后台命令与子智能体,**没有可挂的回复时**单独一行贴在消息列表最后。
 *
 * owner 2026-10-27:右上角「摘要」按钮和它那张卡去掉,后台任务直接放进主对话。原型里它与「思考执行中」同一行,
 * 挂在末尾那条回复的过程行上(见 `ConversationMessage`,由 ChatRoot `backgroundAttachment` 决定挂在哪);
 * 末尾不是一条带过程行的回复(人刚说完话、还没有任何回复、旧样式没有过程行)时,才由这一行来说。
 *
 * 收着时就是一句「后台 · 2 条命令 · 1 个子智能体 ›」(带微光:有东西在动);点开就地展开成单子。
 * 单子展开会让这一行长高 ⇒ measure 按条目数算;开关走 ChatRoot 既有的 `data-collapse-id` 点击委派
 * (`BACKGROUND_TASKS_TOGGLE`),❌ 自己再挂一套开合状态。
 */
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { BackgroundTasksItem } from '@session-chat/model';
import { BACKGROUND_TASKS_TOGGLE } from '@session-chat/state/flatten';
import { Show } from 'solid-js';
import { backgroundTasksRow } from './background-tasks.css';
import { BackgroundTasksList, backgroundTasksLabel, backgroundTasksListHeight } from './background-tasks-parts';

export { BACKGROUND_TASK_ROW_H, backgroundTasksListHeight } from './background-tasks-parts';

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
    const theme = useTheme();
    const headH = () => theme().fonts.body.lineHeight + props.vars.extraH;
    return (
      <div data-slot="background-tasks" class={backgroundTasksRow}>
        <CollapseHeader id={BACKGROUND_TASKS_TOGGLE} collapsible expanded={props.data.expanded} active height={headH()}>
          {backgroundTasksLabel(translate, props.data.commands.length, props.data.subagents.length)}
        </CollapseHeader>
        <Show when={props.data.expanded}>
          <BackgroundTasksList commands={props.data.commands} subagents={props.data.subagents} />
        </Show>
      </div>
    );
  },
});
