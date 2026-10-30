/** @jsxImportSource solid-js */
/**
 * compaction —— 上下文压缩的界线（spec `session-history-replay`）。
 *
 * # 它要回答的问题
 *
 * 压缩之后，agent 那边留下的是一份摘要，不是原文。界面上如果什么都不标，
 * 「它读过我上面说的话」与「它只读过一段摘要」长得一模一样，用户没有任何依据判断
 * 该不该把上面的话再说一遍。合同原话：截断与失败都要留下**可诊断**的痕迹。
 *
 * # 为什么是独立的一行
 *
 * 与日界行（`day-separator`）同一套理由，那份文件里写全了：独立 row 的高度是自己的常量，
 * 邻居的 `measure()` 一个字都不用改；`scrollToItem` 的口径也不被偷偷改掉。
 *
 * # 为什么不把摘要正文画出来
 *
 * 摘要是 agent 写给自己的工作笔记，动辄上千字，摊在正文里会把对话淹掉；而这一行要传达的
 * 只有一件事 —— **这里是一道界**。摘要本身没有丢：它落在这条回合的持久化记录里
 * （`TranscriptCompaction.summary`），要用时取得到。
 * 顺带一个结构上的好处：不画正文，`measure()` 就是常量，不必进 lane A。
 *
 * # 数字为什么挂在 title 上而不是画进标签
 *
 * `preTokens → postTokens` 是用户判断"丢了多少原文"的唯一依据，但把它铺进标签会让这条界线
 * 变成一行读物。折中：标签只说"这里是一道界"，把 trigger / token / 耗时 / 失败原因塞进
 * `title`，鼠标停一下就有。行高因此仍是常量 —— `measure()` 不必进 lane A。
 *
 * # 来源：认 `_meta`，不认文案
 *
 * 喂这条行的是适配器挂在合成 tool call 上的 `_meta.contextCompaction`
 * （`claude-agent-acp` 自己的类型注释写明它 provider-neutral），以及 ACP
 * `session-compaction` RFD 的 `compaction_update`（还没有一家发）。
 * ❌ 别改成去匹配 `"Compact conversation"` 这类标题文案 —— 那是供应商的措辞，改一次就静默失灵。
 */
import type { MeasureCtx } from '@session-chat/core/define';
import { readableLabel, rowTranslator } from '../readable-label';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { TranscriptCompaction } from '@gugu/session-core/acp';
import { boundaryLabel, boundaryRow, boundaryRule } from './boundary.css';

/**
 * 行高（px）。与日界行同一个解剖：发丝线居中，标签 16px 行高上下各留 4px。
 *
 * ⚠️ 改这个值必须同时改 `boundary.css.ts` 里标签的 `line-height`，
 * 否则标签会被行根静静裁掉而高度契约仍然吻合。
 */
export const COMPACTION_ROW_H = 24;

/** 75888 → `75.9k`。压缩前后动辄几万，原样铺出来读不出量级差。 */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function compactionLabel(data: TranscriptCompaction, translate: import('@session-chat/localization').ChatTranslator): string {
      switch (data.status) {
        case 'in_progress':
          return translate('transcript.compacting');
        case 'failed':
          return translate('transcript.compactionFailed');
        default:
          return translate('transcript.compacted');
      }
    }

function boundaryLayout(data: TranscriptCompaction, ctx: MeasureCtx) {
  const actions = 0;
  return readableLabel(compactionLabel(data, rowTranslator(ctx)), ctx, ctx.width - 20 - actions, 12, 18);
}

export const compactionUnitDef = defineUnit<TranscriptCompaction, { rowH: number }>({
  kind: 'compaction',
  // 与日界行同一档呼吸：它也是一个分节符。
  margin: { top: 16, bottom: 12 },
  vars: { rowH: COMPACTION_ROW_H },

  measure(data, ctx, vars_) { return Math.max(vars_.rowH, boundaryLayout(data, ctx).height + 6); },

  Render(props) {
    const translate = useChatTranslator();
    const layout = () => boundaryLayout(props.data, props.ctx.measureCtx!());
    const label = () => compactionLabel(props.data, translate);

    /** 悬停详情。每一格都可能缺（RFD 那条通道一个数都不给），缺了就不占位。 */
    const detail = (): string | undefined => {
      const d = props.data;
      const parts: string[] = [];
      if (d.trigger) parts.push(d.trigger === 'manual' ? '/compact' : 'auto');
      if (d.preTokens !== undefined && d.postTokens !== undefined) {
        parts.push(`${formatTokens(d.preTokens)} → ${formatTokens(d.postTokens)}`);
      }
      if (d.durationMs !== undefined) parts.push(`${Math.round(d.durationMs / 1000)}s`);
      if (d.error) parts.push(d.error);
      return parts.length > 0 ? parts.join(' · ') : undefined;
    };

    return (
      <div
        data-slot="compaction"
        data-status={props.data.status}
        // 读屏按分节读 —— 与日界行同一种语义。
        role="separator"
        aria-label={label()}
        // 标签窄时会收成省略号(boundary.css.ts),title 先给整句,再给排查细节。
        title={[label(), detail()].filter(Boolean).join('\n')}
        class={boundaryRow}
        style={{ height: `${Math.max(props.vars.rowH, layout().height + 6)}px` }}
      >
        <span data-slot="compaction-rule" aria-hidden="true" class={boundaryRule} />
        <span data-slot="compaction-label" class={boundaryLabel} style={{ 'flex-shrink': 0, width: `${Math.min(layout().width, props.ctx.measureCtx!().width - 20)}px` }}>
          {layout().text}
        </span>
        <span data-slot="compaction-rule" aria-hidden="true" class={boundaryRule} />
      </div>
    );
  },
});
