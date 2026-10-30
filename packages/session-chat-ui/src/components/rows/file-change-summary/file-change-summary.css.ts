import { style } from '@vanilla-extract/css'
import { vars } from '@session-chat/styles/theme.css'

export const card = style({
  boxSizing: 'border-box',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusXl,
  overflow: 'hidden',
  color: vars.fgBody,
  fontFamily: vars.fontSans
})
export const header = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 12px',
  boxSizing: 'border-box'
})
export const tile = style({
  width: 40,
  height: 40,
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  background: vars.bg1,
  borderRadius: vars.radiusMd
})
export const title = style({
  flex: 1,
  minWidth: 0,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px'
})
export const ellipsis = style({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal'
})
export const stats = style({
  display: 'flex',
  gap: 4,
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: '18px',
  flexShrink: 0
})
export const adds = style({ color: vars.diffAdded })
export const dels = style({ color: vars.diffDeleted })
export const button = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
  height: 28,
  padding: '0 8px',
  background: 'transparent',
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusMd,
  color: vars.fgBody,
  font: 'inherit',
  fontSize: vars.typeChromeFontSize,
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: vars.bgHover },
    '&:active': { background: vars.bgPress },
    '&:focus-visible': { outline: `2px solid ${vars.link}`, outlineOffset: 1 }
  }
})
export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 12px',
  boxSizing: 'border-box',
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px'
})
export const path = style([
  ellipsis,
  {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    color: vars.fgMuted,
    background: 'transparent',
    border: 0,
    padding: 0,
    font: 'inherit',
    cursor: 'pointer',
    selectors: {
      '&:hover': { color: vars.fg },
      '&:focus-visible': { outline: `2px solid ${vars.link}` }
    }
  }
])
export const footer = style({
  display: 'flex',
  alignItems: 'center',
  padding: '0 12px',
  boxSizing: 'border-box'
})
