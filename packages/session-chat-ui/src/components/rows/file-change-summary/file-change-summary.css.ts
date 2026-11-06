import { style } from '@vanilla-extract/css'
import { vars } from '@session-chat/styles/theme.css'

/** One block, the output card's frame (opened-output.css: the same border, radius and rows). */
export const card = style({
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusXl,
  overflow: 'hidden',
  background: vars.bg,
  color: vars.fgBody,
  fontFamily: vars.fontSans
})
const row = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  width: '100%',
  padding: '0 12px',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'background-color 150ms',
  selectors: {
    '&:hover': { background: vars.bgHover },
    '&:active': { background: vars.bgPress },
    '&:focus-visible': { outline: `2px solid ${vars.link}`, outlineOffset: '-2px' },
    '&:disabled': { cursor: 'default', background: 'transparent' }
  }
} as const
/** 「已编辑 3 个文件 +54 −19 ⌄」: the whole line opens and closes the list. */
export const head = style({ ...row, fontSize: vars.typeChromeFontSize, lineHeight: '20px', fontWeight: 500, color: vars.fg })
/** The head's words wrap where they must (measured), never hidden. */
export const headLabel = style({ flex: '0 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'normal' })
/** One file: the whole row is the button. Rows after the first (or after the head) get the output card's hairline. */
export const file = style({ ...row, containerType: 'inline-size', selectors: { ...row.selectors, '&[aria-disabled]': { cursor: 'default', background: 'transparent' }, '& + &, button + &': { borderTop: `1px solid ${vars.border}` } } })
export const stats = style({
  flex: '1 0 auto',
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: '18px',
  fontWeight: 400,
  whiteSpace: 'nowrap'
})
export const adds = style({ color: vars.diffAdded })
export const dels = style({ color: vars.diffDeleted })
/** The head's ⌄ turns over while the list is open. */
export const turn = style({ transition: 'transform 150ms', selectors: { '&[data-open]': { transform: 'rotate(180deg)' } } })
