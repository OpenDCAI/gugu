import { style, styleVariants } from '@vanilla-extract/css';
import { outcomeAction, outcomeActionPrimary } from '@session-chat/components/rows/turn-outcome/turn-outcome.css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract（每个实例由 HookNoticeCard 写入）─────────────────

export type HookNoticeStyleVars = {
  height: number;
  padY: number;
  padX: number;
  headerH: number;
  bodyH: number;
  gap: number;
  footerH: number;
};

export const hookNoticeVars = createVariableThemeContract<HookNoticeStyleVars>({
  height: null,
  padY: null,
  padX: null,
  headerH: null,
  bodyH: null,
  gap: null,
  footerH: null
});

/**
 * hook 通知卡 —— 照 assistant-ui `Error` primitive 的解剖（`ErrorPrimitive.Root` +
 * `ErrorPrimitive.Message`，官方示例是 `rounded-md border border-destructive/20
 * bg-destructive/5 p-3` 的一块带 `role` 的框）。
 *
 * 为什么要一块框：这句话**不是 agent 说的**。它是 hook 的输出，被 ACP 桥当成普通助手
 * 消息发过来（见 `lib/hook-notice.ts`）。不加框它就混在回复里，读者只能靠开头那个
 * 加粗的「Notice:」自己分辨 —— 而那正是桥凑出来的、看着像正文的东西。
 */
export const noticeRoot = style({
  boxSizing: 'border-box',
  height: hookNoticeVars.height,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: hookNoticeVars.gap,
  padding: `${hookNoticeVars.padY} ${hookNoticeVars.padX}`,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: vars.radiusMd
});

/**
 * 三档语气，取自 SDK 自己的说明（`SDKInformationalMessage.level`）：
 * 「'notice' 以灰色呈现；'suggestion' 与 'warning' 更显眼」。
 * ⇒ notice 一路灰到底；suggestion 正文色；warning 借 `fgError`。
 * ❌ 没有单独的 warning 色标就不新造一个：主题里没有的颜色，暗色下必然失控。
 */
export const noticeTone = styleVariants({
  notice: {
    color: vars.fgMuted,
    borderColor: vars.border,
    background: vars.bg1
  },
  suggestion: {
    color: vars.fgBody,
    borderColor: vars.border,
    background: vars.bg2
  },
  warning: {
    color: vars.fgBody,
    borderColor: `color-mix(in srgb, ${vars.fgError} 35%, transparent)`,
    background: `color-mix(in srgb, ${vars.fgError} 6%, transparent)`
  }
});

export const noticeHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  height: hookNoticeVars.headerH,
  minWidth: 0,
  color: vars.fgMuted,
  fontSize: vars.typeMentionFontSize,
  lineHeight: 1
});

/** 说话的那个 hook 的名字。等宽 + 全大写太吵，这里只用一个小圆点分隔。 */
export const noticeHook = style({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal'
});

export const noticeDot = style({
  width: '4px',
  height: '4px',
  flexShrink: 0,
  borderRadius: vars.radiusFull,
  background: 'currentColor'
});

/** 正文带。高度是量出来的（见 `measureHookNotice`），❌ 别在这里写 min/max。 */
export const noticeBody = style({
  position: 'relative',
  height: hookNoticeVars.bodyH,
  minWidth: 0
});

/** 卡底：选项一颗一行，行距与卡内间距同值。高度由调用方量（`NoticeExtra.footer.h`）。 */
export const noticeFooter = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: hookNoticeVars.gap,
  height: hookNoticeVars.footerH,
  minWidth: 0
});

/**
 * 卡底的选项 = turn-outcome 的胶囊，只是会话栏窄了能折行（一行仍是 28 = 18 + 2×5）。量高按 `NOTICE_OPTION` 算折行；
 * 字族写明而不靠继承，因为量的就是这个字族。左右内距是胶囊自己的 10。
 */
export const NOTICE_OPTION = { size: 13, weight: 500, lineH: 18, padX: 10, padY: 5 } as const;
const wraps = {
  height: 'auto',
  maxWidth: '100%',
  paddingBlock: `${NOTICE_OPTION.padY}px`,
  lineHeight: `${NOTICE_OPTION.lineH}px`,
  whiteSpace: 'normal',
  textAlign: 'start',
  fontFamily: vars.fontSans
} as const;
export const noticeOption = style([outcomeAction, wraps]);
/**
 * 第一颗（人该点的那颗）实心：宿主主按钮的配法（tokens.css `--primary` 墨底 / `--primary-fg` 纸字）= 这里的 fg 底、bg 字。
 * turn-outcome 的主按钮只有字色；徽章的 bg2 底在等批准的卡（`suggestion` 档也是 bg2）上看不出来。
 */
const filled = { background: vars.fg, color: vars.bg } as const;
export const noticeOptionPrimary = style([
  outcomeActionPrimary,
  wraps,
  { ...filled, selectors: { '&:hover, &:focus-visible': { ...filled, opacity: 0.88 }, '&:active': filled } }
]);
