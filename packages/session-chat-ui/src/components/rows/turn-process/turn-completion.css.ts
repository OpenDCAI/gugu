import { globalStyle, style } from '@vanilla-extract/css';

export const completionActions = style({ display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' });
// Unlike hover-only message actions, this strip is the visible ending of a tool-only turn.
globalStyle(`${completionActions} button`, { opacity: 1 });
