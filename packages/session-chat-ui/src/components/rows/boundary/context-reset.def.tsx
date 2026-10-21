/** @jsxImportSource solid-js */
/**
 * context-reset —— 引擎接不上这条会话，已经替它开了一条新的（spec `session-history-replay`）。
 *
 * # 它要回答的问题
 *
 * `session/load` 失败时产品的选择是「会话照常打开」而不是把它变成一个打不开的东西。
 * 但降级不能是**静默**的：会话页现在自己存着历史，屏幕上照旧是满屏对话，
 * 而 agent 那边一个字都没有。用户看着历史，理所当然以为它读过 —— 它没有。
 *
 * ⚠️ 与 `compaction` 用同一套视觉（`boundary.css.ts`），但**不是**同一件事：
 * 压缩后 agent 手里还有一份摘要，这里它手里什么都没有。
 * 差别落在标签那句话上，❌ 别把两种行合并。
 *
 * # 为什么原因不画在行上
 *
 * 原因（provider 认不出这条会话 / 换了一家引擎找不到 rollout）是给排查用的，
 * 落在条目里（`TranscriptContextReset.reason`）与日志里；行上只说**后果**，
 * 因为用户此刻要做的判断只有一个：上面的话要不要重说一遍。
 */
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { TranscriptContextReset } from '@gugu/session-core/acp';
import { boundaryLabel, boundaryRow, boundaryRule } from './boundary.css';

/**
 * 行高（px）。与 `compaction` / 日界行同一个解剖。
 *
 * ⚠️ 改这个值必须同时改 `boundary.css.ts` 里标签的 `line-height`，
 * 否则标签会被行根静静裁掉而高度契约仍然吻合。
 */
export const CONTEXT_RESET_ROW_H = 24;

export const contextResetUnitDef = defineUnit<TranscriptContextReset, { rowH: number }>({
  kind: 'context-reset',
  margin: { top: 16, bottom: 12 },
  vars: { rowH: CONTEXT_RESET_ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const translate = useChatTranslator();
    const label = (): string => translate('transcript.contextReset');

    return (
      <div
        data-slot="context-reset"
        role="separator"
        aria-label={label()}
        class={boundaryRow}
        // 排查时要的是原因,给鼠标停留看得到,而不摊在正文里;标签窄时会收成省略号,所以整句放在原因前面。
        title={`${label()}\n${props.data.reason}`}
        style={{ height: `${props.vars.rowH}px` }}
      >
        <span data-slot="context-reset-rule" aria-hidden="true" class={boundaryRule} />
        <span data-slot="context-reset-label" class={boundaryLabel}>
          {label()}
        </span>
        <span data-slot="context-reset-rule" aria-hidden="true" class={boundaryRule} />
      </div>
    );
  },
});
