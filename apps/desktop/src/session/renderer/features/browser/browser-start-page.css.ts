import { globalStyle, style } from '@vanilla-extract/css';
import { SESSION_CHAT_FONT_STACK } from '@renderer/lib/chat/font-stack';

export const startPage = style({
  height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '32px 24px',
  background: 'color-mix(in srgb, var(--background) 98%, var(--foreground))', fontFamily: SESSION_CHAT_FONT_STACK.sans.join(', '),
  containerType: 'inline-size',
});
export const content = style({ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 40 });
export const section = style({ display: 'flex', flexDirection: 'column', gap: 16 });
export const heading = style({ margin: 0, fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--foreground)' });
export const tools = style({
  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8,
  '@container': { '(max-width: 440px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});
export const tool = style({ background: 'var(--background)', minWidth: 0 });
export const apps = style({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 12 });
export const app = style({ minWidth: 0, height: 'auto', flexDirection: 'column', gap: 12, padding: '16px 8px' });
export const appIcon = style({ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32 });
globalStyle(`${appIcon} :is(svg, img)`, { width: '100%', height: '100%' });
