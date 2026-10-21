/** @jsxImportSource solid-js */
/**
 * tool-run — 一段连续工具调用折成的一句话（#4981，owner 2026-09-06）。
 *
 * 与 `turn-process` 同一副骨架（同一条时间线、同一个折叠头、同一把 ViewState 开关），
 * 只是标签不是「过程 · N 步」而是成句的摘要「搜索了 3 个模式、读了 2 个文件」。
 * 展开不会长高这一行 —— flatten 在它下面重新发出原始行。
 */
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { defineUnit } from '@session-chat/core/units';
import type { ToolRunItem } from '@session-chat/model';
import {
  turnProcessHeaderSlot,
  turnProcessLine,
  turnProcessRow,
} from '@session-chat/components/rows/turn-process/turn-process.css';

export const toolRunUnitDef = defineUnit<ToolRunItem, { extraH: number }>({
  kind: 'tool-run',
  margin: { top: 2, bottom: 2 },
  vars: { extraH: HEADER_ROW_EXTRA_H },

  measure(_data, ctx, vars_) {
    return ctx.theme.fonts.body.lineHeight + vars_.extraH;
  },

  Render(props) {
    const theme = useTheme();
    const height = () => theme().fonts.body.lineHeight + props.vars.extraH;
    // ViewState keeps the inverted flag inherited from the original store:
    // `isCollapsed(id) === true` means expanded (see view-state.ts).
    const expanded = () => props.ctx.viewState.isCollapsed(props.data.id);
    return (
      <div
        data-slot="tool-run"
        data-turn-id={props.data.turnId}
        data-step-count={props.data.stepCount}
        data-live={props.data.live ? 'true' : 'false'}
        data-expanded={expanded() ? 'true' : 'false'}
        class={turnProcessRow}
        style={{ height: `${height()}px` }}
      >
        <div class={turnProcessLine} data-slot="tool-timeline-line">
          <div class={turnProcessHeaderSlot}>
            <CollapseHeader
              id={props.data.id}
              collapsible
              expanded={expanded()}
              active={props.data.live}
              height={height()}
            >
              {props.data.label}
            </CollapseHeader>
          </div>
        </div>
      </div>
    );
  },
});
