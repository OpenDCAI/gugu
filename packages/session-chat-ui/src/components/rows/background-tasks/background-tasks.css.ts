import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** 整行的根。与别的定高行一样裁在引擎给的高度里:量和画一时对不上,宁可裁掉,❌ 压到下一行上。 */
export const backgroundTasksRow = style({
  overflow: 'hidden',
  color: vars.fgMuted,
  display: 'flex',
  flexDirection: 'column',
});

/** 单子:沿用原来「输出」面板里那两节的密度面板 —— 外层 bg1 + 内距 4 + 圆角,逐行悬停。 */
export const backgroundTasksList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 4,
  borderRadius: vars.radiusMd,
  backgroundColor: vars.bg1,
  maxWidth: 600,
});

export const backgroundTaskRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: vars.radiusSm,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  color: vars.fg,
  selectors: { '&:hover': { backgroundColor: vars.bgHover } },
});

export const backgroundTaskIcon = style({
  width: 20,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  color: `color-mix(in srgb, ${vars.fg} 35%, transparent)`,
});

export const backgroundTaskName = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

/** 时长 / 步数:等宽数字,每秒在变也不左右挪。 */
export const backgroundTaskMeta = style({
  flexShrink: 0,
  color: `color-mix(in srgb, ${vars.fg} 45%, transparent)`,
  fontFamily: vars.fontMono,
  fontSize: vars.typeChromeTinyFontSize,
  fontVariantNumeric: 'tabular-nums',
});

export const backgroundTaskButton = style({
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  padding: 4,
  border: 0,
  borderRadius: vars.radiusSm,
  background: 'none',
  cursor: 'pointer',
  color: `color-mix(in srgb, ${vars.fg} 35%, transparent)`,
  transition: 'color 150ms',
  selectors: { '&:hover': { color: `color-mix(in srgb, ${vars.fg} 70%, transparent)` } },
});

export const backgroundTaskStop = style({
  selectors: { '&:hover': { color: vars.fgError } },
});

/** ×(只收起、不停)平时藏着,悬停那一行才露出来 —— 它不是这一行的主动作。 */
export const backgroundTaskDismiss = style({
  visibility: 'hidden',
  selectors: { [`${backgroundTaskRow}:hover &, &:focus-visible`]: { visibility: 'visible' } },
});

/**
 * 悬停子智能体那一行弹出的浮层(原来摘要卡里那张,w-80 / p-3 / gap-2)。portal 到 `[data-chat-root]` 下、position: fixed ——
 * 行裁在引擎给的高度里(`overflow: hidden` + 行容器 `contain: paint`),留在行里会被裁掉。
 */
export const subagentPanel = style({
  position: 'fixed',
  zIndex: 30,
  width: 320,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: vars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.bg,
  boxShadow: `0 4px 16px color-mix(in srgb, ${vars.fg} 10%, transparent)`,
  color: vars.fg,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
});

/** 名字独占一行、折行写全:它是派它时写的任务描述,长短不定(原卡 10-19 那条)。 */
export const subagentPanelName = style({
  overflowWrap: 'anywhere',
  fontSize: 14,
});

export const subagentPanelMeta = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  fontFamily: vars.fontMono,
  fontSize: vars.typeChromeTinyFontSize,
  fontVariantNumeric: 'tabular-nums',
});

export const subagentPanelModel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: `color-mix(in srgb, ${vars.fg} 35%, transparent)`,
});

export const subagentPanelElapsed = style({
  flexShrink: 0,
  color: `color-mix(in srgb, ${vars.fg} 45%, transparent)`,
});

export const subagentPanelEmpty = style({
  fontFamily: vars.fontMono,
  fontSize: vars.typeChromeTinyFontSize,
  color: `color-mix(in srgb, ${vars.fg} 35%, transparent)`,
});

/** 每一步都列出来,❌ 截掉几条:太长就滚动(owner 2026-09-06)。原卡 max-h-56。 */
export const subagentTimeline = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 224,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
});

export const subagentTimelineStep = style({
  display: 'flex',
  flexDirection: 'column',
  flexShrink: 0,
  minWidth: 0,
});

export const subagentStepTrigger = style({
  display: 'flex', alignItems: 'center', gap: 8, height: 20, width: '100%', minWidth: 0,
  padding: 0, border: 0, background: 'transparent', textAlign: 'left', font: 'inherit', color: 'inherit',
  cursor: 'pointer', selectors: { '&:disabled': { cursor: 'default' } },
});

export const subagentStepAction = style({ flexShrink: 0, whiteSpace: 'nowrap' });
export const subagentStepChevron = style({ width: 12, flexShrink: 0, marginLeft: 'auto' });
export const subagentStepDetail = style({
  paddingLeft: 25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  color: `color-mix(in srgb, ${vars.fg} 70%, transparent)`,
});

/** 记号格:一行字高,与 GridLoader 同宽(17)。 */
export const subagentTimelineMarker = style({
  width: 17,
  height: 20,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  color: `color-mix(in srgb, ${vars.fg} 35%, transparent)`,
  selectors: {
    '&[data-status="running"]': { color: vars.live },
  },
});

export const subagentTimelineErrorDot = style({
  width: 6,
  height: 6,
  borderRadius: 9999,
  backgroundColor: vars.fgError,
});

export const subagentTimelineTitle = style({
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'pre',
  textOverflow: 'ellipsis',
  color: `color-mix(in srgb, ${vars.fg} 70%, transparent)`,
});
