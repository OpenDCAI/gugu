/** @jsxImportSource solid-js */
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { PreviewWindow } from '@session-chat/components/primitives/PreviewWindow';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { Block } from '@session-chat/core/markdown/document';
import { flattenBlockHeadings } from '@session-chat/core/markdown/parse';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatThinking } from '@session-chat/model';
import {
  thinkingCardVars,
  thinkingRoot,
  thinkingSummaryText,
  type ThinkingStyleVars,
} from './thinking.css';
import { thinkingSummary } from './thinking-summary';
import { sx } from '@session-chat/styles/sprinkles.css';

export type ThinkingVars = {
  /** Measure-only: vertical padding baked into the body block-stack layout. */
  padY: number;
  /** Measure-only: preview window height during active thinking. */
  windowH: number;
};

const THINKING_VARS: ThinkingVars = {
  padY: 8,
  windowH: 72,
};

function thinkingHeaderH(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function layoutThinkingBody(blocks: Block[], ctx: MeasureCtx, padY: number) {
  return layoutBlockStack(blocks, ctx, { padY });
}

/**
 * 还在想的时候走增量解析(与流式中的 assistant 消息同一条):稳定前缀的 Block 对象不变,measure 缓存命中,
 * 每块只重解析、重量尾巴 —— 整段重解析是 O(n) 每块、整轮 O(n²)。
 */
function thinkingBlocks(item: ChatThinking, ctx: MeasureCtx): Block[] {
  const text = item.text ?? '';
  return flattenBlockHeadings(
    item.status === 'thinking'
      ? ctx.caches.parseBlocksStreaming(item.id, text)
      : ctx.caches.parseBlocks(item.id, text)
  );
}

function ThinkingHeader(props: {
  item: ChatThinking;
  expanded: boolean;
  collapsible: boolean;
  headerH: number;
}) {
  const translate = useChatTranslator();

  /**
   * 行头文案。**只经 translator 取字**——这是 [[session-chat-ui]] spec body 的
   * 「Solid transcript chrome 只经这份能力取文案」。
   *
   * ⚠️ 这里曾是 #3482 的残留：5 句英文写死在这个函数里，而不是写在 JSX 上。
   * 该票扫描用的筛子是「文件没 import useChatTranslator」+「JSX 属性/文本子节点里的英文字面量」，
   * 两层都看不见它——文案由函数返回、经 `{label()}` 进 JSX，**在 JSX 位置上没有任何字面量**。
   * ⇒ 判「某文件是否绕过 translator」不能按文案在源码里的位置数，要按它最终有没有经过 translator。
   *
   * 秒数是**数据**（已算好的整秒），只作为插值送进去；`{seconds}` 的位置由各语言的模板自己定。
   */
  const label = () => {
    if (props.item.status === 'thinking') {
      return translate('transcript.thinking');
    }
    if (props.item.durationMs !== undefined) {
      if (props.item.durationMs < 1000) return translate('transcript.thoughtBriefly');
      return translate('transcript.thoughtFor', {
        seconds: Math.floor(props.item.durationMs / 1000),
      });
    }
    return translate('transcript.thought');
  };

  /**
   * 这一段思考的要旨（#4981 #7）。
   *
   * ⚠️ 只在思考**已经结束**时挂：还在想的时候，行下面就是那扇实时预览窗，正文一字一句
   * 都在滚，头上再抄一句是重复。owner 报的也正是结束态那三行 —— 「短暂思考」四个字，
   * 一行不说自己想了什么。
   *
   * ⚠️ 走 `trailing` 不走 `children`：`children` 是**一个** flex 项，长标签会在里面折行，
   * 而这一行是定高裁切的 —— 折了行，末尾那截就被裁掉。这条坑在 execute 行上量过
   * （见 `CollapseHeader.trailing` 的注释）。
   */
  const summary = () =>
    props.item.status === 'thinking' ? undefined : thinkingSummary(props.item.text);

  return (
    <CollapseHeader
      id={props.item.id}
      collapsible={props.collapsible}
      expanded={props.expanded}
      active={props.item.status === 'thinking'}
      height={props.headerH}
      trailing={
        <Show when={summary()}>
          {(text) => <span class={thinkingSummaryText}>{text()}</span>}
        </Show>
      }
    >
      <span
        aria-live={props.item.status === 'thinking' ? 'polite' : undefined}
        aria-atomic={props.item.status === 'thinking' ? 'false' : undefined}
      >
        {label()}
      </span>
    </CollapseHeader>
  );
}

function thinkingMeasure(item: ChatThinking, ctx: MeasureCtx, vars: ThinkingVars): number {
  const headerH = thinkingHeaderH(ctx);
  const isExpanded = ctx.expanded(item.id);

  if (!isExpanded && item.status !== 'thinking') return headerH;

  const body = layoutThinkingBody(thinkingBlocks(item, ctx), ctx, vars.padY);

  if (!isExpanded) return headerH + vars.windowH;
  return headerH + body.height;
}

function ThinkingUnitRender(props: { data: ChatThinking; ctx: RenderCtx; vars: ThinkingVars }) {
  const theme = useTheme();
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const headerH = () => theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H;

  const blocks = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return [];
    return thinkingBlocks(props.data, ctx);
  });

  const body = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    return layoutThinkingBody(blocks(), ctx, props.vars.padY);
  });

  /**
   * Whether expanding this row would show reasoning the collapsed row does not.
   *
   * Two different collapsed states, so two answers. Once the thought is done the
   * collapsed row is the header alone, so any reasoning at all is hidden behind
   * the chevron. While it is still arriving the collapsed row is a fixed window
   * onto the tail — nothing is hidden until the text outgrows that window.
   *
   * A thought that carries no blocks at all is neither: expanding it opens the
   * body's padding onto an empty box. Growing by a strip of nothing is not
   * revealing something.
   */
  const collapsible = createMemo(() => {
    if (blocks().length === 0) return false;
    if (props.data.status === 'thinking') return (body()?.height ?? 0) > props.vars.windowH;
    return true;
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return headerH();
    return thinkingMeasure(props.data, ctx, props.vars);
  });

  const showBody = () => isExpanded() || props.data.status === 'thinking';
  const bodyH = () => body()?.height ?? 0;

  const styleVars = (): ThinkingStyleVars => ({ height: totalH() });

  return (
    <div
      class={`${sx({ color: 'fgPassive' })} ${thinkingRoot}`}
      style={assignInlineVars(thinkingCardVars, pxTokens(styleVars()))}
    >
      <ThinkingHeader
        item={props.data}
        expanded={isExpanded()}
        collapsible={collapsible()}
        headerH={headerH()}
      />
      <Show when={showBody()}>
        <Show
          when={isExpanded()}
          fallback={
            <PreviewWindow
              height={props.vars.windowH}
              maxH={props.vars.windowH}
              overlay="fade-top"
              autoScrollBottom={props.data.status === 'thinking'}
              contentHeight={() => bodyH()}
            >
              <Show when={body()}>{(b) => <BlockStackView node={b()} />}</Show>
            </PreviewWindow>
          }
        >
          <Show when={body()}>{(b) => <BlockStackView node={b()} />}</Show>
        </Show>
      </Show>
    </div>
  );
}

export const thinkingUnitDef = defineUnit<ChatThinking, ThinkingVars>({
  kind: 'thinking',
  margin: { top: 6, bottom: 6 },
  vars: THINKING_VARS,

  estimate(item, ctx, vars): number {
    const headerH = thinkingHeaderH(ctx);
    const isExpanded = ctx.expanded(item.id);

    if (!isExpanded) {
      if (item.status === 'thinking') return headerH + vars.windowH;
      return headerH;
    }

    const lines = Math.max(1, Math.ceil((item.text?.length ?? 0) / 60));
    return headerH + 2 * vars.padY + proseLinesHeight(lines, ctx.theme);
  },

  measure: thinkingMeasure,

  Render: ThinkingUnitRender,
});
