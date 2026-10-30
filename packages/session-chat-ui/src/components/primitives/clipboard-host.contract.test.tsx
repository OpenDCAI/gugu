/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { CopyButton } from './CopyButton';
import { CommandsContext } from '../contexts/CommandsContext';
import type { ChatCommands } from '../../commands';

let dispose: (() => void) | undefined;
let host: HTMLDivElement;
afterEach(() => { dispose?.(); host?.remove(); vi.restoreAllMocks(); });
function mount(commands: ChatCommands) {
  host = document.createElement('div'); document.body.append(host);
  dispose = render(() => <CommandsContext.Provider value={() => commands}><CopyButton text={'代码 中文\nconst n = 938;\n'} variant="overlay" /></CommandsContext.Provider>, host);
  return host.querySelector('button')!;
}

describe('transcript copy is owned by its host', () => {
  it('starts the exact host write in the click gesture without touching the denied browser clipboard', async () => {
    const browser = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Write permission denied.'));
    const writeClipboardText = vi.fn(async (_text: string) => {});
    const onCopyError = vi.fn();
    mount({ writeClipboardText, onCopyError }).click();
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('代码 中文\nconst n = 938;\n');
    await until('host copy succeeds', () => host.querySelector('button')?.getAttribute('aria-label') === 'Copy - Copied');
    expect(browser).not.toHaveBeenCalled(); expect(onCopyError).not.toHaveBeenCalled();
  });
  it('reports a missing host capability rather than using the WebView', async () => {
    const browser = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const onCopyError = vi.fn(); vi.spyOn(console, 'error').mockImplementation(() => {});
    mount({ onCopyError }).click();
    await until('copy completes through a writer or failure', () => onCopyError.mock.calls.length === 1 || browser.mock.calls.length === 1);
    expect(onCopyError).toHaveBeenCalledOnce();
    expect(onCopyError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(browser).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Copied');
  });
  it('preserves a native refusal without silently falling back to browser copy', async () => {
    const browser = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const error = new Error('Native clipboard refused'); const onCopyError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount({ writeClipboardText: vi.fn().mockRejectedValue(error), onCopyError }).click();
    await until('copy completes through a writer or failure', () => onCopyError.mock.calls.length === 1 || browser.mock.calls.length === 1);
    expect(onCopyError).toHaveBeenCalledExactlyOnceWith(error); expect(browser).not.toHaveBeenCalled();
  });
});
