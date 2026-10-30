import { type ChatLayout, isDoubleColumnLayout } from '@session-chat/core/layout/preset';

export type MessageVars = {
  cardBorder: number;
  collapsedMaxH: number;
  expandedMaxH: number;
  userCardPadX: number;
  userCardPadY: number;
  attachThumb: number;
  attachGap: number;
  footerH: number;
};

/** Subset of MessageVars projected into CSS via the VE contract. */
export type MessageStyleVars = {
  userCardPadX: number;
  userCardPadY: number;
  cardBorder: number;
  attachThumb: number;
  attachGap: number;
  attachChipH: number;
  attachChipW: number;
};

export const USER_MESSAGE_ACTION_GAP = 4;

/** Reserve the action row even while its hover controls are hidden. */
export function userMessageActionsHeight(vars: Pick<MessageVars, 'footerH'>): number {
  return USER_MESSAGE_ACTION_GAP + vars.footerH;
}

/**
 * Per-layout overrides of the user card geometry (#4874 「对话视图」).
 *
 * `base` turns the bordered full-width card into a borderless pill with tighter
 * padding. Kept as a pure function of (vars, layout) so measure, estimate and
 * render all derive the same numbers — the geometry contract stays one source.
 */
export function effectiveMessageVars(vars: MessageVars, layout: ChatLayout | undefined): MessageVars {
  if (!isDoubleColumnLayout(layout)) return vars;
  return { ...vars, cardBorder: 0, userCardPadX: 16, userCardPadY: 12 };
}

/**
 * Width the user card may occupy inside the row. In `base` the layout's
 * `userGutter` is reserved on the left so the pill never spans the column —
 * but never more than a quarter of it: a narrow column (a session squeezed into
 * one of several screen blocks, #7052) keeps ≥3/4 for the pill instead of
 * crushing it to one character per line.
 */
export function userAvailableWidth(ctxWidth: number, layout: ChatLayout | undefined): number {
  if (!isDoubleColumnLayout(layout)) return ctxWidth;
  const gutter = Math.min(Math.max(0, layout?.userGutter ?? 0), Math.floor(ctxWidth / 4));
  return Math.max(1, ctxWidth - gutter);
}

/** Available width for block layout inside the user card. */
export function userInnerWidth(ctxWidth: number, vars: MessageVars): number {
  return Math.max(1, ctxWidth - 2 * vars.userCardPadX - 2 * vars.cardBorder);
}

/**
 * Outer width of the `base` pill: hug the widest measured line, capped at the
 * available width. Text geometry never changes with the hug because every
 * fragment is projected at an absolute x measured against the full inner width;
 * only the painted box shrinks. Returns `available` outside `base` or when the
 * content has no measurable extent (attachments-only, empty).
 */
export function userPillWidth(
  available: number,
  contentWidth: number | null,
  vars: MessageVars,
  layout: ChatLayout | undefined
): number {
  if (!isDoubleColumnLayout(layout) || contentWidth === null) return available;
  const hug = Math.ceil(contentWidth) + 2 * vars.userCardPadX + 2 * vars.cardBorder;
  return Math.max(1, Math.min(available, hug));
}

/**
 * 附件卡的几何(#5269)。
 *
 * 形状是 owner 2026-09-10 定的,他说了四遍我才照做:**文件名放在图块下面、在方框之外**
 * (「至于文件名称,可以考虑放附件图标的下部分,不占用阴影是不是更好看」→ 我连着四版都把名字
 * 塞在框里 → 「如果我说了四次,你还是坚持文件名在框内那你只能这样扁平」)。
 *
 * ⇒ 一枚 = 一个有厚度的图块(图片铺缩略图,文件放字形)+ 图块**下方**一行名字。名字不在方框里,
 * 所以方框可以做得小而立体,而不是一条横躺的扁片。
 *
 * 与 assistant-ui 的关系:表面处理(浅底、圆角、hover 深一档、无描边)仍照 `elements/file` 的
 * muted 变体;**排布是他要求偏离上游的那一处** —— 上游那件是「图标 + 名字」横排在同一个框里。
 * 宽度同样定死(他:「人家的文件 ui 大小是固定这么大,你是超长变宽」),名字长了截断。
 */
export const ATTACH_TILE = 48;
/**
 * ❌ 这里原来有 `ATTACH_TILE_RADIUS = 12`。圆角不进 `measure()`,它不是尺寸契约的一员,
 * 放在这里等于给 8 档圆角表开了第二个真源(而 12 恰好就是表里 `--radius-xl` 那一档)。
 * 2026-09-22 起图块的圆角直接消费 `vars.radiusXl`,见 `user-message.css.ts`。
 */
export const ATTACH_TILE_GLYPH = 22;
/** 图块与名字之间。 */
export const ATTACH_LABEL_GAP = 6;
/** 名字那一行:标注档 12/18(#7333)。量高与绘制读同一个数。 */
export const ATTACH_LABEL_LINE = 18;
/** 一枚有多宽 —— 比图块宽一些,名字才放得下几个字。 */
export const ATTACH_CHIP_W = 88;

/** 一枚有多高 = 图块 + 间距 + 一行名字。与文件名长短无关。 */
export function attachChipHeight(): number {
  return ATTACH_TILE + ATTACH_LABEL_GAP + ATTACH_LABEL_LINE;
}

/** 一枚有多宽 —— 定值;只有整条比它还窄(极窄视口)时才让步。 */
export function attachChipWidth(available: number): number {
  return Math.max(1, Math.min(ATTACH_CHIP_W, available));
}

/**
 * 附件条占掉的高度(含它与气泡之间那道间距);一件都没有时是 0(❌ 不留那道间距)。
 * 卡片同宽 ⇒ 一行放得下几枚是除法,不必按每个名字的宽度贪心排。
 */
export function attachStripHeight(count: number, available: number, vars: MessageVars): number {
  if (count <= 0) return 0;
  const chipW = attachChipWidth(available);
  const perRow = Math.max(1, Math.floor((available + vars.attachGap) / (chipW + vars.attachGap)));
  const rows = Math.ceil(count / perRow);
  return rows * attachChipHeight() + (rows - 1) * vars.attachGap + vars.attachGap;
}
