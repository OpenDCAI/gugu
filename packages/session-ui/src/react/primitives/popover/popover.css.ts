import { style } from '@vanilla-extract/css';
import { popupShadow, popupSurface } from '@session-ui/styles/recipes/popup-surface.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

// 这里从前把 popupSurface 的圆角/底色/前景色/transformOrigin 与整套 8 条动画选择器
// 又抄了一遍(实测与 popupSurface 的那一段**逐字节相同**),外加自己那份没有环的投影。
// 改成组合之后,浮层表达只剩一个定义处。
//
// `border` 换成 popupShadow 里的环(#3334 §6.1):环不占布局,边框占 —— renderer 侧
// `lib/ui/popover.tsx` 在 P1 因为同一条理由做过同一处改动,这是它在 session-ui 这半边的对应项。
export const popupContent = style([
  popupSurface,
  popupShadow,
  {
    zIndex: 50,
    display: 'flex',
    overflow: 'hidden',
    flexDirection: 'column',
    gap: '1rem',
    padding: '1rem',
    fontSize: tokenVars.textSm,
  },
]);

export const popoverHeader = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: tokenVars.textSm,
});

export const popoverTitle = style({
  fontWeight: 400,
});

export const popoverDescription = style({
  color: vars.foregroundMuted,
});
