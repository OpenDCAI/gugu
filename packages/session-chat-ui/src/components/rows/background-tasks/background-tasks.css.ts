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
