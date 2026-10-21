/** @jsxImportSource solid-js */
/**
 * 计划审批（Claude 的 ExitPlanMode，#7139）画成一张通知卡：头写状态，正文是计划的 markdown，等批准时卡底是选项。
 * 不另存状态：等不等批准看会话现有的待批请求（`permissionFor`）；批了没批看工具状态（done / error，与 question-tools
 * 同一条判据）；点选项交给宿主的 `onResolvePermission`，答的就是输入框上那条本要答的请求，所以卡在流里时宿主不再出那一条。
 */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import {
  HOOK_NOTICE_VARS,
  HookNoticeCard,
  estimateHookNotice,
  measureHookNotice,
  type HookNoticeVars,
  type NoticeExtra,
} from '@session-chat/components/rows/message/HookNoticeCard';
import { NOTICE_OPTION, noticeOption, noticeOptionPrimary } from '@session-chat/components/rows/message/hook-notice-card.css';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import { defineUnit, type SegmentCtx } from '@session-chat/core/units';
import { useChatTranslator, type ChatTranslationKey } from '@session-chat/localization';
import type { ToolNode } from '@session-chat/model';
import { For, type JSX } from 'solid-js';

export type PlanReview = {
  kind: 'plan-review';
  id: string;
  /** 计划正文（markdown），ExitPlanMode 的 `plan` 参数。 */
  text: string;
  state: 'awaiting' | 'open' | 'approved' | 'rejected';
  /** 等批准时那条请求的 id 与选项（排好、译好；量高与画法读同一份）。 */
  requestId?: string;
  options: Array<{ optionId: string; kind: string; label: string }>;
};

/** 各家批计划的选项 id → 咕咕自己的话，按含义一张表；认不得的 id 照用它自己的 name。 */
const OPTION_KEYS: Readonly<Record<string, ChatTranslationKey>> = {
  'exit-plan-default': 'transcript.planStart', // Claude
  proceed_once: 'transcript.planStart', // qwen
  default: 'transcript.planStart', // qoder
  plan_approve: 'transcript.planStart', // kimi
  proceed_always: 'transcript.planStartAcceptEdits', // qwen
  acceptEdits: 'transcript.planStartAcceptEdits', // qoder
  restore_previous: 'transcript.planStartRestore', // qwen
  'exit-plan-auto': 'transcript.planStartAuto', // Claude
  'exit-plan-clear-auto': 'transcript.planStartClearAuto', // Claude
  'exit-plan-bypass': 'transcript.planStartBypass', // Claude
  yolo: 'transcript.planStartBypass', // qoder
  reject: 'transcript.planKeepPlanning', // Claude
  cancel: 'transcript.planKeepPlanning', // qwen
  plan: 'transcript.planKeepPlanning', // qoder
  plan_revise: 'transcript.planKeepPlanning', // kimi
  plan_reject_and_exit: 'transcript.planRejectExit', // kimi
};

function planText(rawInput: string | undefined): string {
  try {
    const plan = (JSON.parse(rawInput ?? 'null') as { plan?: unknown } | null)?.plan;
    return typeof plan === 'string' ? plan : '';
  } catch {
    return rawInput ?? '';
  }
}

/** 一颗一行：「按计划开始」（allow_once）在最上、实心，「不批」在最下，其余几种开始方式在中间。 */
const optionRank = (kind: string): number => (kind === 'allow_once' ? 0 : kind.startsWith('reject') ? 2 : 1);

export function planReviewFromItem(item: Extract<ToolNode, { toolCallId: string }>, ctx: SegmentCtx): PlanReview {
  const request = ctx.permissionFor?.(item.toolCallId);
  const state = request ? 'awaiting' : item.status === 'done' ? 'approved' : item.status === 'error' ? 'rejected' : 'open';
  const label = (optionId: string, name: string) => (OPTION_KEYS[optionId] ? ctx.translate(OPTION_KEYS[optionId]) : name || optionId);
  const options = [...(request?.options ?? [])]
    .sort((a, b) => optionRank(a.kind) - optionRank(b.kind))
    .map(({ optionId, kind, name }) => ({ optionId, kind, label: label(optionId, name) }));
  // 计划在 rawInput.plan（Claude、qwen、droid），没有就是请求带来的正文（qoder、kimi）。
  const text = planText(item.rawInput) || (item.outputText ?? '');
  return { kind: 'plan-review', id: item.id, text, state, ...(request && { requestId: request.requestId }), options };
}

/** 一颗选项的高：会话栏窄了会折行，按卡内宽度（减去卡的左右内距、1px 边与胶囊左右内距）量行数。 */
function optionHeight(label: string, ctx: MeasureCtx): number {
  const width = ctx.width - 2 * (HOOK_NOTICE_VARS.padX + 1 + NOTICE_OPTION.padX);
  const font = `${NOTICE_OPTION.weight} ${NOTICE_OPTION.size}px ${ctx.theme.themeVars.fontSans}`;
  return measureSoftWrap(label, width, font).visualLineCount * NOTICE_OPTION.lineH + 2 * NOTICE_OPTION.padY;
}

function planExtra(item: PlanReview, ctx: MeasureCtx, render: () => JSX.Element = () => null): NoticeExtra {
  const n = item.options.length;
  const h = item.options.reduce((sum, option) => sum + optionHeight(option.label, ctx), (n - 1) * HOOK_NOTICE_VARS.gap);
  return { blocks: ctx.caches.parseBlocks(`${item.id}:plan`, item.text), ...(n > 0 && { footer: { h, render } }) };
}

function PlanReviewRender(props: { data: PlanReview; ctx: RenderCtx; vars: HookNoticeVars }) {
  const translate = useChatTranslator();
  const commands = useCommands();
  const state = () =>
    props.data.state === 'awaiting'
      ? translate('transcript.awaitingPermission')
      : props.data.state === 'approved'
        ? translate('transcript.planApproved')
        : props.data.state === 'rejected'
          ? translate('transcript.planRejected')
          : null;
  const footer = () => (
    <For each={props.data.options}>
      {(option, index) => (
        <button
          type="button"
          class={index() === 0 ? noticeOptionPrimary : noticeOption}
          data-option-id={option.optionId}
          disabled={!commands().onResolvePermission}
          onClick={() => {
            const requestId = props.data.requestId;
            if (requestId) commands().onResolvePermission?.({ requestId, optionId: option.optionId, source: 'plan-review' });
          }}
        >
          {option.label}
        </button>
      )}
    </For>
  );
  const extra = () => {
    const ctx = props.ctx.measureCtx?.();
    return ctx ? planExtra(props.data, ctx, footer) : undefined;
  };
  return (
    <HookNoticeCard
      data={props.data}
      ctx={props.ctx}
      vars={props.vars}
      tone={props.data.state === 'awaiting' ? 'suggestion' : 'notice'}
      label={translate('transcript.planReview') + (state() ? ` · ${state()}` : '')}
      srLabel={translate('transcript.planReview')}
      slot="plan-review"
      extra={extra()}
    />
  );
}

export const planReviewUnitDef = defineUnit<PlanReview, HookNoticeVars>({
  kind: 'plan-review',
  margin: { top: 8, bottom: 8 },
  vars: HOOK_NOTICE_VARS,
  estimate: (item, ctx, vars) => estimateHookNotice(item, ctx, vars, planExtra(item, ctx)),
  measure: (item, ctx, vars) => measureHookNotice(item, ctx, vars, planExtra(item, ctx)),
  Render: PlanReviewRender,
});
