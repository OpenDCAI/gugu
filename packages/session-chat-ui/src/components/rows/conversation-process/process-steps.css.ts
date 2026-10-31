import { globalStyle, style } from '@vanilla-extract/css';
import { viewportTopFade } from '@session-chat/styles/effects.css';

export const root = style({ position: 'relative', width: '86%' });
export const viewport = style({ overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none', overflowAnchor: 'none' });
globalStyle(`${viewport}::-webkit-scrollbar`, { width: 0, height: 0, display: 'none' });
export const fade = style([viewportTopFade, { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }]);
