/** @jsxImportSource solid-js */
/**
 * session-notice —— 这条会话的运行条件出了事，而会话照常在跑（spec `session-always-openable`）。
 *
 * # 为什么是一行
 *
 * owner 2026-09-19 的裁决：「任何 bug 都不应该让会话打不开才对吧,也不应该有任何需要横幅性质的
 * ui 表达,有问题就像消息一样贴消息列表才对吧」。故障和「模型回了一段话」「上下文被压缩了」
 * 是同一类东西 —— 这条对话里发生的一件事，所以它的位置就是列表里的一行。
 *
 * ⚠️ 与 `compaction` / `context-reset` 共用 `boundary.css.ts` 的视觉，但说的不是一件事：
 * 那两条讲的是 **agent 手里的上下文**变了（只剩摘要 / 什么都没有），
 * 这一条讲的是**上下文没问题、跑它的条件变了**(或它的 agent 改了名)。❌ 别合并。
 *
 * # 为什么细节不画在行上
 *
 * 同 `context-reset`：provider 那句原文是给排查用的，落在条目里（`detail`）与悬停提示里。
 * 行上只说用户此刻要做的那个判断 —— 我选的模型没跑，现在跑的是哪个。
 */
import type { MeasureCtx } from '@session-chat/core/define';
import { readableLabel, rowTranslator } from '../readable-label';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { TranscriptSessionNotice } from '@gugu/session-core/acp';
import { boundaryLabel, boundaryLabelShrinkable, boundaryRow, boundaryRule } from './boundary.css';

/** 行高（px）。与 `compaction` / `context-reset` / 日界行同一个解剖。 */
export const SESSION_NOTICE_ROW_H = 24;

function noticeLabel(data: TranscriptSessionNotice, translate: import('@session-chat/localization').ChatTranslator): string {
      // 供应商提示:它说什么行上就写什么(title 原文),description 在悬停提示里。
      if (data.code === 'provider-notice') return data.title ?? data.detail;
      const running = data.effectiveValue;
      // #6396 改名那一条由宿主发出,恒带新旧两个名字(sessionpage-rename-announcement.ts)。
      if (data.code === 'agent-renamed') {
        return translate('transcript.sessionNotice.agentRenamed', {
          previous: data.previousValue ?? '',
          running: running ?? '',
        });
      }
      // 推理档那一条只在 provider 确认了现在的档之后才会发出(runtime applyInitialEffort),恒带 running。
      if (data.code === 'effort-unavailable') {
        return translate('transcript.sessionNotice.effortUnavailable', { running: running ?? '' });
      }
      // ⚠️ provider 不报 model 维度时（#5047 那个 codex 桥**正是**这种）我们说不出「现在跑的是什么」。
      //    那时 ❌ 不许把空串插进句子 —— 行上会写成「现在跑的是 」，断在那里。
      if (running === undefined) {
        return translate(
          data.code === 'model-unavailable'
            ? 'transcript.sessionNotice.modelUnavailableDefault'
            : 'transcript.sessionNotice.modelSubstitutedUnknown'
        );
      }
      return data.code === 'model-unavailable'
        ? translate('transcript.sessionNotice.modelUnavailable', { running })
        : translate('transcript.sessionNotice.modelSubstituted', { running });
    }

function boundaryLayout(data: TranscriptSessionNotice, ctx: MeasureCtx) {
  const actions = 0;
  return readableLabel(noticeLabel(data, rowTranslator(ctx)), ctx, ctx.width - 20 - actions, 12, 18);
}

export const sessionNoticeUnitDef = defineUnit<TranscriptSessionNotice, { rowH: number }>({
  kind: 'session-notice',
  margin: { top: 16, bottom: 12 },
  vars: { rowH: SESSION_NOTICE_ROW_H },

  measure(data, ctx, vars_) { return Math.max(vars_.rowH, boundaryLayout(data, ctx).height + 6); },

  Render(props) {
    const translate = useChatTranslator();
    const layout = () => boundaryLayout(props.data, props.ctx.measureCtx!());
    const label = () => noticeLabel(props.data, translate);

    return (
      <div
        data-slot="session-notice"
        data-notice-code={props.data.code}
        role="separator"
        aria-label={label()}
        class={boundaryRow}
        // 排查要的是 provider 那句原文,给鼠标停留看得到,而不摊在正文里。
        title={props.data.detail}
        style={{ height: `${Math.max(props.vars.rowH, layout().height + 6)}px` }}
      >
        <span data-slot="session-notice-rule" aria-hidden="true" class={boundaryRule} />
        <span data-slot="session-notice-label" class={`${boundaryLabel} ${boundaryLabelShrinkable}`} style={{ 'flex-shrink': 0, width: `${Math.min(layout().width, props.ctx.measureCtx!().width - 20)}px` }}>
          {layout().text}
        </span>
        <span data-slot="session-notice-rule" aria-hidden="true" class={boundaryRule} />
      </div>
    );
  },
});
