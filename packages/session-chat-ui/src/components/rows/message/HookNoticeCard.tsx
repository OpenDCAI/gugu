/** @jsxImportSource solid-js */
/**
 * HookNoticeCard —— hook 说的那一句，不再冒充 agent 的回复（#4981）。也给计划审批用（#7139）：正文可换成 markdown 块、可带卡底，见 `NoticeExtra`。
 *
 * 解剖照 assistant-ui 的 `Error` primitive：`ErrorPrimitive.Root` 是一块带 `role` 的框
 * （官方示例 `rounded-md border border-destructive/20 bg-destructive/5 p-3`），
 * `ErrorPrimitive.Message` 是里面那句话。这里把「谁说的」提到框头上 —— 因为一条
 * hook 通知最先要回答的问题就是**哪个 hook 在说话**（`Stop` / `UserPromptSubmit` / …）。
 *
 * # 正文按纯文本排，❌ 不过 markdown
 *
 * SDK 自己写死了口径：`SDKInformationalMessage` 的说明是「Hosts render `content` as
 * plaintext at the given level」。hook 是随手写的 shell 脚本，输出里出现 `#`、`*`、`_`
 * 是家常便饭 —— 交给 markdown 解析就会把一句普通的话变成一级标题或者吞掉星号。
 * ⇒ 这里**自己拼**一个纯文本块（转义后的一段，空格与换行原样保留），既拿到真正的
 * 换行/折行排版，又一个字都不经过 markdown。
 *
 * # 几何
 *
 * 高度 = 上下内边距 + 头一行 + 间距 + 正文栈高。三项里只有正文栈是量出来的，
 * 用的还是消息那条既有的 `layoutBlockStack` ⇒ `measure() === offsetHeight` 与
 * 普通助手消息同源，不引入第二套排版。
 */
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { StackLayout } from '@session-chat/core/compose';
import type { MeasureCtx, Measured, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { Block } from '@session-chat/core/markdown/document';
import { plainTextBlock } from '@session-chat/core/markdown/to-html';
import type { HookNoticeLevel } from '@session-chat/lib/hook-notice';
import type { ChatMessage } from '@session-chat/model';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo, type JSX } from 'solid-js';
import { srOnly } from './message.css';
import {
  hookNoticeVars,
  noticeBody,
  noticeDot,
  noticeFooter,
  noticeHeader,
  noticeHook,
  noticeRoot,
  noticeTone
} from './hook-notice-card.css';

export type HookNoticeVars = {
  padY: number;
  padX: number;
  /** 头一行与正文之间的距离。 */
  gap: number;
};

export const HOOK_NOTICE_VARS: HookNoticeVars = {
  padY: 8,
  padX: 10,
  gap: 4
};

type NoticeItem = Pick<ChatMessage, 'id' | 'text'>;
/** 换掉的正文块（缺省 = 纯文本那一块）与卡底（高 + 渲染，缺省没有）；量高与画法读同一份。 */
export type NoticeExtra = { blocks?: Block[]; footer?: { h: number; render: () => JSX.Element } };

function innerWidth(width: number, vars: HookNoticeVars): number {
  return Math.max(0, width - 2 * vars.padX);
}

/** 纯文本拼成**一个**块：一段，行与行之间是原样的换行，不是段落。 */
export function hookNoticeBlocks(id: string, body: string): Block[] {
  return [plainTextBlock(`${id}:hook-notice`, body)];
}

const footerSpace = (vars: HookNoticeVars, extra?: NoticeExtra): number => (extra?.footer ? vars.gap + extra.footer.h : 0);

function bodyHeight(item: NoticeItem, ctx: MeasureCtx, vars: HookNoticeVars, extra?: NoticeExtra): number {
  const stack = layoutBlockStack(
    extra?.blocks ?? hookNoticeBlocks(item.id, item.text),
    { ...ctx, width: innerWidth(ctx.width, vars) },
    { isCollapsed: ctx.isCollapsed }
  );
  return stack.height;
}

export function measureHookNotice(
  item: NoticeItem,
  ctx: MeasureCtx,
  vars: HookNoticeVars,
  extra?: NoticeExtra
): number {
  const lineH = ctx.theme.fonts.body.lineHeight;
  return 2 * vars.padY + lineH + vars.gap + bodyHeight(item, ctx, vars, extra) + footerSpace(vars, extra);
}

/**
 * 没有 MeasureCtx 时的估高（lane B）。行宽按 60 个字符估，与 `estimateDelivery` 同口径 ——
 * ❌ 别在这里另发明一个估法：两个估法会在同一批行上给出不同的预留高度。
 */
export function estimateHookNotice(
  item: NoticeItem,
  ctx: MeasureCtx,
  vars: HookNoticeVars,
  extra?: NoticeExtra
): number {
  const lineH = ctx.theme.fonts.body.lineHeight;
  const lines = Math.max(1, Math.ceil(item.text.length / 60));
  return 2 * vars.padY + lineH + vars.gap + proseLinesHeight(lines, ctx.theme) + footerSpace(vars, extra);
}

/** `warning` 要打断人，读屏该当场念；另外两档是背景信息，念完手上的再念。 */
function ariaRole(level: HookNoticeLevel): 'alert' | 'status' {
  return level === 'warning' ? 'alert' : 'status';
}

/**
 * 一张通知卡。语气与那行小标题**由调用方给** —— 这块框现在有两个用处：
 * hook 说的话，以及「某个子智能体跑完了」（#4981）。两者在信息结构上是同一件事：
 * 一句不是 agent 写的、需要读者知道但不该混进回复里的话。
 */
export function HookNoticeCard(props: {
  data: NoticeItem;
  ctx: RenderCtx;
  vars: HookNoticeVars;
  tone: HookNoticeLevel;
  /** 框头那一行：谁在说话。 */
  label: string;
  /** 读屏先听见的那个词（「提示」/「警告」/「子智能体」）。 */
  srLabel: string;
  /** 结构标记，两个用处各自可定位。 */
  slot?: string;
  extra?: NoticeExtra;
}) {
  const mCtx = (): MeasureCtx | undefined => props.ctx.measureCtx?.();

  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx) return null;
    return layoutBlockStack(
      props.extra?.blocks ?? hookNoticeBlocks(props.data.id, props.data.text),
      { ...ctx, width: innerWidth(ctx.width, props.vars) },
      { isCollapsed: ctx.isCollapsed }
    );
  });

  const lineH = (): number => mCtx()?.theme.fonts.body.lineHeight ?? 20;
  const bodyH = (): number => stack()?.height ?? lineH();
  const total = (): number =>
    2 * props.vars.padY + lineH() + props.vars.gap + bodyH() + footerSpace(props.vars, props.extra);

  return (
    <div
      data-slot={props.slot ?? 'hook-notice'}
      data-hook-notice-level={props.tone}
      role={ariaRole(props.tone)}
      class={`${noticeRoot} ${noticeTone[props.tone]}`}
      style={assignInlineVars(
        hookNoticeVars,
        pxTokens({
          height: total(),
          padY: props.vars.padY,
          padX: props.vars.padX,
          headerH: lineH(),
          bodyH: bodyH(),
          gap: props.vars.gap,
          footerH: props.extra?.footer?.h ?? 0
        })
      )}
    >
      {/* 读屏先听见「这不是 agent 在说话」，再听内容 —— 视觉上那句话由框和头一行承担。 */}
      <div class={srOnly}>
        {props.srLabel}
        {' · '}
        {props.data.text}
      </div>
      <div class={noticeHeader} data-slot="hook-notice-header" aria-hidden="true">
        <span class={noticeDot} />
        <span class={noticeHook} title={props.label}>
          {props.label}
        </span>
      </div>
      <div class={noticeBody} data-slot="hook-notice-body">
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
      </div>
      <Show when={props.extra?.footer}>
        {(footer) => (
          <div class={noticeFooter} data-slot="hook-notice-footer">
            {footer().render()}
          </div>
        )}
      </Show>
    </div>
  );
}
