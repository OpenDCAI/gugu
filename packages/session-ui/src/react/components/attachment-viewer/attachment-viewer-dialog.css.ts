import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const imageContainer = style({
  display: 'flex',
  minHeight: 0,
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  padding: '1rem',
  paddingTop: 0,
});

export const image = style({
  // 高度跟着图走,只封顶 —— ❌ 不撑满:小图被放进一个 80vh 的盒子里,四周全是空的。
  maxHeight: '70vh',
  maxWidth: '100%',
  objectFit: 'contain',
});

export const unavailable = style({
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
});

// 文本预览。等宽 + 保留换行 + 长行横向滚(❌ 不换行:代码和日志被折行之后就读不出结构了),
// 竖向交给 ScrollContainer。
export const textContainer = style({
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  gap: '0.5rem',
  padding: '1rem',
  paddingTop: 0,
});

export const textScroll = style({
  minHeight: 0,
  // 高度跟着内容走,长了才滚(封顶由 ScrollContainer 的 `maxHeight` prop 给,见组件里的注释)
  // —— 与图片那一支同一条:❌ 不撑满一个固定高的盒子。
  borderRadius: tokenVars.radiusMd,
  backgroundColor: vars.surfaceBaseSelected,
});

export const text = style({
  margin: 0,
  padding: '0.75rem',
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textTiny,
  lineHeight: 1.6,
  color: vars.foreground,
  // `pre-wrap` 而不是 `pre`:换行与缩进照留(日志和代码要的就是这个),但一整段没有换行的
  // 正文会折回来 —— 用 `pre` 的话它会横着跑出弹层右缘,而那正是粘贴长文本最常见的形状。
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});

export const truncatedNote = style({
  margin: 0,
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
});
