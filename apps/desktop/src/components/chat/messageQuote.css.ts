import { style } from '@vanilla-extract/css';

/** IM keeps its compact quote tier; the shared session preview has its own caption tier. */
export const imSourcePreview = style({
  selectors: {
    '&[data-conversation-source-markdown]': {
      fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)',
      maxHeight: 'calc(var(--lh-body) * 2)', opacity: 0.55,
    },
  },
});
