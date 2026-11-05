/** @jsxImportSource solid-js */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from '@vitest/browser/context';
import { render } from 'solid-js/web';
import { InputSendStatus, INPUT_SEND_FAILURE_HEIGHT } from './components/rows/message/InputSendStatus';
import { CommandsContext } from './components/contexts/CommandsContext';
import { ChatTranslationProvider, defaultChatTranslator } from './localization';
import type { ChatCommands } from './commands';
import type { ChatMessage } from './model';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
function status(state: 'unknown' | 'failed', retryable: boolean, commands: ChatCommands, chinese = false) {
  const host = document.createElement('div'); document.body.appendChild(host);
  const item: ChatMessage = { kind: 'message', id: 'input-one', seq: 0, role: 'user', text: 'test input', sendStatus: { state, retryable } };
  const dispose = render(() => <ChatTranslationProvider value={{ locale: () => chinese ? 'zh-CN' : 'en-US', translate: key =>
    chinese && key === 'transcript.resendInput' ? '重发' : defaultChatTranslator(key) }}>
    <CommandsContext.Provider value={() => commands}><InputSendStatus item={item} top={0} right={0} /></CommandsContext.Provider>
  </ChatTranslationProvider>, host);
  cleanup.push(() => { dispose(); host.remove(); }); return host;
}

it.each([false, true])('unknown recovery only sends on an explicit click (Chinese=%s)', async chinese => {
  const resend = vi.fn(); const host = status('unknown', true, { onRetrySend: resend }, chinese);
  expect(resend).not.toHaveBeenCalled();
  expect(host.textContent).toBe(chinese ? '重发' : 'Resend');
  await page.getByRole('button', { name: chinese ? '重发' : 'Resend', exact: true }).click();
  expect(resend).toHaveBeenCalledExactlyOnceWith('input-one');
});

it('preserves the failed-message row geometry and button style', () => {
  const unknown = status('unknown', true, { onRetrySend: vi.fn() });
  const failed = status('failed', true, { onRetrySend: vi.fn() });
  const a = unknown.querySelector<HTMLElement>('[role=alert]')!, b = failed.querySelector<HTMLElement>('[role=alert]')!;
  expect(a.style.cssText).toBe(b.style.cssText);
  expect(a.getBoundingClientRect().height).toBe(INPUT_SEND_FAILURE_HEIGHT);
  expect(unknown.querySelector('button')!.style.cssText).toBe(failed.querySelector('button')!.style.cssText);
  expect(failed.textContent).toContain('Retry');
});

it('does not expose an unsupported resend on an older host or with no command', () => {
  const old = status('unknown', false, { onRetrySend: vi.fn() });
  const detached = status('unknown', true, {});
  expect(old.querySelector('button')).toBeNull(); expect(detached.querySelector('button')).toBeNull();
  expect(old.textContent).toContain('Delivery unknown'); expect(detached.textContent).toContain('Delivery unknown');
});
