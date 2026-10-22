/** @jsxImportSource solid-js */
import { clsx } from 'clsx';
import { Show } from 'solid-js';
import type { ChatSubagentToolCall } from '@session-chat/model';
import { chevron, chevronExpanded } from '@session-chat/components/primitives/collapse-header.css';
import {
  subagentHeader,
  subagentHeaderCollapsible,
  subagentName,
} from './subagent.css';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { ShimmerText } from '@session-chat/components/primitives/ShimmerText';
import { useChatTranslator } from '@session-chat/localization';

/**
 * ❌ 这里曾有一格转圈的指示器(16px 格子 + 6px 间距),跑完了留空「为了对齐」。
 * owner 2026-09-06 截图:落定后那一行左边多出一块空白,别的工具行都顶格。这一行是
 * 「启动子智能体」这次调用,与别的工具行同一套:在跑 = 名字微光,做完 = 没有微光,
 * 不另占一格。
 */
export function SubagentHeader(props: {
  item: ChatSubagentToolCall;
  height: number;
  expanded?: boolean;
  collapsible?: boolean;
}) {
  const translate = useChatTranslator();
  const name = () =>
    props.item.background
      ? translate('transcript.background', { name: props.item.name })
      : props.item.name;

  return (
    <div
      class={clsx(subagentHeader, props.collapsible && subagentHeaderCollapsible)}
      style={{ height: `${props.height}px` }}
      data-slot="tool-call-trigger"
      data-collapse-id={props.collapsible ? props.item.id : undefined}
      role={props.collapsible ? 'button' : undefined}
      aria-expanded={props.collapsible ? Boolean(props.expanded) : undefined}
      title={
        props.item.phase === 'failed'
          ? (props.item.error ?? translate('transcript.failed'))
          : undefined
      }
    >
      <ShimmerText class={subagentName} active={props.item.status === 'running'} title={name()}>
        {name()}
      </ShimmerText>
      {/* 这个子任务被要求做什么(#4981)。与 tool / execute 行戴同一颗片。
          没有它时并行派出去的几个子任务是几行一模一样的「Agent 已完成」。 */}
      <Show when={props.item.task}>
        {(task) => (
          <span class={summaryChip} data-slot="tool-call-query" title={task()}>
            {task()}
          </span>
        )}
      </Show>
      {/* ❌ 这里曾有一格状态词(「已完成」/「失败」)。owner 2026-09-06:「启动后面不要跟
          已完成,启动就好了」—— 这一行是那次调用,不是那个智能体;它跑完没有由完成通知
          那一行(`subagent-done-tool-call`)说,启动失败由下面的原因片说。 */}
      {/* 失败原因摆到行上,❌ 不再只塞进 title。
          原来这一行是「● Agent 失败」四个字,原因藏在悬浮提示里 —— 而那个提示本身还
          永远是空的(见 subagent.def 里 reason 的那段注释),等于原因根本拿不到。
          片和 tool / execute 行戴的是同一颗:一行、等宽、淡底、超长省略号收尾,
          不改变行高。全文仍在 title 里,鼠标停住能读全。 */}
      <Show when={props.item.phase === 'failed' && props.item.error}>
        {(reason) => (
          <span class={summaryChip} data-slot="tool-call-error" title={reason()}>
            {reason()}
          </span>
        )}
      </Show>
      <Show when={props.collapsible}>
        <span class={clsx(chevron, props.expanded && chevronExpanded)} aria-hidden="true">
          ›
        </span>
      </Show>
    </div>
  );
}
