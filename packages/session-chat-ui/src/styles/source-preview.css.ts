import { globalStyle, style } from '@vanilla-extract/css';

export const sourcePreviewBody = style({
  position: 'relative', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3,
  maxHeight: 54, overflow: 'hidden', fontSize: 12, lineHeight: '18px', textAlign: 'left',
  whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0,
  selectors: { '&[data-source-truncated]::after': {
    content: '"…"', position: 'absolute', right: 0, bottom: 0, paddingLeft: 4,
    background: 'var(--popover, var(--chat-bg-2))',
  } },
});
export const sourcePreviewTwoLines = style({ WebkitLineClamp: 2, maxHeight: 36 });
globalStyle(`${sourcePreviewBody} *`, { maxWidth: '100%', margin: 0, fontSize: 'inherit', lineHeight: 'inherit', pointerEvents: 'none' });
globalStyle(`${sourcePreviewBody} pre`, { whiteSpace: 'pre-wrap', overflow: 'hidden' });
globalStyle(`${sourcePreviewBody} table`, { tableLayout: 'fixed', borderCollapse: 'collapse', width: '100%' });
globalStyle(`${sourcePreviewBody} th, ${sourcePreviewBody} td`, { padding: '0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
