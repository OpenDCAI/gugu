/**
 * opened-output.css.ts — 附件卡片(#7193):一轮交出来的几份东西连成一块列表(圆角框,行间一条细线),
 * 每行左边一格类型色图标、中间名字和「文档 · HTML」、右边一个箭头。
 *
 * ⚠️ 每个尺寸都要留在 `OPENED_OUTPUT_ROW_H` / `OPENED_OUTPUT_GAP` 里:`measure()` 是常量,
 * 画高了不会让行长高,只会被静静裁掉。
 */
import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** 行外那一圈:组首行上面、组末行下面各留一档与回复隔开(`measure` 同一笔账)。 */
export const slot = style({
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
});

export const card = style({
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  width: '100%',
  flex: '1 1 auto',
  padding: '0 12px',
  // 窄的时候「侧边栏 ▾」收成一枚 ▾,把地方让给名字(下面 modeLabel 的 @container)。
  containerType: 'inline-size',
  borderLeft: `1px solid ${vars.border}`,
  borderRight: `1px solid ${vars.border}`,
  borderBottom: `1px solid ${vars.border}`,
  background: vars.bg,
  color: vars.fgBody,
  fontFamily: vars.fontSans,
  textAlign: 'left',
  userSelect: 'none',
  transition: 'background-color 150ms',
  selectors: {
    '&[data-first]': {
      borderTop: `1px solid ${vars.border}`,
      borderTopLeftRadius: vars.radiusXl,
      borderTopRightRadius: vars.radiusXl,
    },
    '&[data-last]': {
      borderBottomLeftRadius: vars.radiusXl,
      borderBottomRightRadius: vars.radiusXl,
    },
  },
});

export const cardClickable = style([
  card,
  {
    cursor: 'pointer',
    selectors: {
      '&:hover': { background: vars.bgHover },
      '&:active': { background: vars.bgPress },
      '&:focus-visible': { outline: `2px solid ${vars.link}`, outlineOffset: '-2px' },
    },
  },
]);

export const tile = style({
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40px',
  height: '40px',
  borderRadius: vars.radiusMd,
});

export const text = style({
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
});

const oneLine = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
} as const;

// #7333 文字两行(名字 14/20 + 说明 12/18 = 38)落在 72 的行里;名字是紧凑界面档,说明是标注档。
export const name = style({
  ...oneLine,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  fontWeight: 500,
  color: vars.fg,
});

/** 「文档 · HTML」是标记不是正文:字阶的 caption 一档。 */
export const detail = style({
  ...oneLine,
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: '18px',
  color: vars.fgMuted,
});

/**
 * 名字一行:窄的时候省略**中间**、后缀留着(「codex-参考…截图.png」),一眼还认得出是什么文件。
 * 主干可缩、带省略号;后缀不缩。
 */
export const nameRow = style({
  display: 'block',
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  fontWeight: 500,
  color: vars.fg,
});

export const nameStem = style({
  ...oneLine,
  minWidth: 0,
  flex: '0 1 auto',
});

export const nameTail = style({
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
});

/**
 * 右边「侧边栏 ▾」:写明点整行时怎么打开,点它弹出全部打开方式(「Open in ▾」)。
 * 与会话页其它小按钮同一副样子:细边框、控件圆角、caption 之上一档的字。
 */
export const modeButton = style({
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  height: '28px',
  padding: '0 6px 0 10px',
  '@container': {
    '(max-width: 260px)': { padding: '0 6px' },
  },
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusMd,
  background: vars.bg,
  color: vars.fgBody,
  fontFamily: vars.fontSans,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  cursor: 'pointer',
  transition: 'background-color 150ms',
  selectors: {
    '&:hover': { background: vars.bg1 },
    '&:active': { background: vars.bgPress },
    '&:focus-visible': { outline: `2px solid ${vars.link}`, outlineOffset: '1px' },
  },
});

/** 「侧边栏」那两个字:卡窄于 260px 时收起,只留 ▾(读屏仍有按钮自己的 aria-label)。 */
export const modeLabel = style({
  '@container': {
    '(max-width: 260px)': { display: 'none' },
  },
});

/** 行尾箭头:告诉人这一行能点;点它与点整行是同一件事。 */
export const chevron = style({
  flex: '0 0 auto',
  display: 'flex',
  color: vars.fgPassive,
});
