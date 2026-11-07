import { createChatContext, createChatState } from '@gugu/session-chat-ui';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { codeLine, codeWrapper } from '@session-chat/components/rows/markdown/code/code.css';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/mobile/phone-look.css';
import '@renderer/features/assistant/assistant-today.css';
import '@/components/assistant/assistant-task-chat.css';

const SQL = "begin;\n-- Read-only transaction\nselect 'readable' as message;\ncommit;";
const TEXT = `Inline \`24495eb5…\`\n\n\`\`\`sql\n${SQL}\n\`\`\`\n\n\`\`\`\n${SQL}\n\`\`\`\n\n- Nested code\n\n  \`\`\`sql\n  ${SQL.replaceAll('\n', '\n  ')}\n  \`\`\``;
const cleanups: (() => void)[] = [];
const previousTheme = document.documentElement.dataset.theme;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

async function mount(theme: 'light' | 'dark', role: 'user' | 'assistant', surface = 'native') {
  document.documentElement.dataset.theme = theme;
  const host = document.body.appendChild(document.createElement('div'));
  host.className = `em${theme}`;
  host.style.cssText = 'position:fixed;inset:0;width:1000px;height:1200px;background:var(--background);color:var(--foreground)';
  const surfaceHost = host.appendChild(document.createElement('div'));
  surfaceHost.style.cssText = 'height:100%;display:flex';
  if (surface === 'phone') surfaceHost.setAttribute('data-phone-shell', '');
  if (surface === 'today') surfaceHost.className = 'ta-chat';
  if (surface === 'task') surfaceHost.className = 'assistant-task-chat-window';
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 } });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'code', seq: 0, role, text: TEXT },
  ] }]);
  const root = createRoot(surfaceHost);
  cleanups.push(() => { root.unmount(); state.dispose(); context.dispose(); host.remove(); });
  // Use Code's synchronous cache-hit path for these palette assertions.
  expect(await context.sharedCaches.highlightWhenReady(SQL, 'sql')).not.toBeNull();
  root.render(<AgentConversationView context={context} state={state} />);
  await until('code tokens rendered in the actual message bubble', () => host.querySelectorAll(`.${codeWrapper} span[style*="--shiki-light"]`).length > 5);
  await until('nested code grammar loaded', () => !!host.querySelector('.gg-md pre code span[style*="--shiki-light"]'));
  return host;
}

function rgba(css: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

const rgb = (css: string) => rgba(css).slice(0, 3);

function contrast(fg: string, bg: string) {
  const luminance = (css: string) => rgb(css).reduce((sum, value, index) => {
    const c = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][index] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it.each(['light', 'dark'] as const)('pairs code text and tokens with both bubble surfaces in the %s theme', async theme => {
  for (const role of ['user', 'assistant'] as const) {
    const host = await mount(theme, role);
    const card = host.querySelector<HTMLElement>('[data-user-card]')!;
    const scheme = role === 'user' ? theme === 'light' ? 'dark' : 'light' : theme;
    const background = getComputedStyle(card).backgroundColor;
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
    const fences = [...card.querySelectorAll<HTMLElement>(`.${codeWrapper}`)];
    expect(fences).toHaveLength(2);
    for (const fence of fences) {
      const style = getComputedStyle(fence);
      const border = rgba(style.borderTopColor);
      expect(border[3]).toBeCloseTo(255 * 0.08, 0);
      for (const [index, channel] of rgb(style.color).entries()) {
        expect(Math.abs(border[index] - channel)).toBeLessThanOrEqual(6);
      }
      expect(style.borderTopWidth).toBe('1px');
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
    const lines = [...card.querySelectorAll<HTMLElement>(`.${codeLine}`)];
    expect(lines.length).toBe(8);
    for (const line of lines) {
      expect(getComputedStyle(line).color).toBe(getComputedStyle(card).color);
      expect(contrast(getComputedStyle(line).color, background)).toBeGreaterThanOrEqual(4.5);
    }
    const tokens = [...card.querySelectorAll<HTMLElement>('span[style*="--shiki-light"]')];
    expect(tokens.some(token => token.textContent?.includes('begin'))).toBe(true);
    expect(tokens.some(token => token.textContent?.includes('Read-only'))).toBe(true);
    for (const token of tokens) {
      expect(rgb(getComputedStyle(token).color)).toEqual(rgb(token.style.getPropertyValue(`--shiki-${scheme}`)));
      expect(contrast(getComputedStyle(token).color, background), token.textContent ?? '').toBeGreaterThanOrEqual(4.5);
    }
    const inline = card.querySelector<HTMLElement>(':not(pre) > code')!;
    expect(inline.textContent).toBe('24495eb5…');
    expect(getComputedStyle(inline).color).toBe(getComputedStyle(card).color);
  }
});

it.each(['light', 'dark'] as const)('keeps non-inverted phone and assistant surfaces on the ambient %s palette', async theme => {
  for (const surface of ['phone', 'today', 'task']) {
    const host = await mount(theme, 'user', surface);
    for (const token of host.querySelectorAll<HTMLElement>('span[style*="--shiki-light"]')) {
      expect(rgb(getComputedStyle(token).color), surface).toEqual(rgb(token.style.getPropertyValue(`--shiki-${theme}`)));
    }
  }
});
