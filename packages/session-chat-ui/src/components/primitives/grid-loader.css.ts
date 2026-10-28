import { style } from '@vanilla-extract/css';

/** 与过程行的大脑图标同宽(17),点 4、点距 2。 */
export const gridLoader = style({
  display: 'inline-grid',
  gridTemplateColumns: 'repeat(3, 4px)',
  gap: 2,
  width: 17,
  justifyContent: 'center',
  flex: 'none',
});

export const gridLoaderCell = style({
  width: 4,
  height: 4,
  borderRadius: 9999,
  background: 'currentColor',
  opacity: 0.15,
  transition: 'opacity 300ms',
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
});

export const gridLoaderCellOn = style({ opacity: 0.9 });
