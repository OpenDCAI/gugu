/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { CopyButton } from './CopyButton';
import { CommandsContext } from '../contexts/CommandsContext';

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { dispose?.(); host?.remove(); vi.restoreAllMocks(); });

describe('clipboard rejection feedback', () => {
  for (const variant of ['inline', 'overlay'] as const) {
    it(`forwards the original ${variant} copy failure to the host and permits retry`, async () => {
      const error = new Error('Clipboard permission denied for /Users/alice/private.txt with sk-private_token\nprivate stack');
      const onCopyError = vi.fn();
      const write = vi.spyOn(navigator.clipboard, 'writeText')
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      host = document.createElement('div');
      document.body.appendChild(host);
      dispose = render(() => <CommandsContext.Provider value={() => ({ onCopyError })}><CopyButton text="message" variant={variant} /></CommandsContext.Provider>, host);
      const button = host.querySelector('button')!;
      button.click();
      expect(write).toHaveBeenCalledOnce(); // The native call still starts in the user gesture.
      await until('copy failure reaches the host', () => onCopyError.mock.calls.length === 1);
      expect(onCopyError).toHaveBeenCalledWith(error);
      expect(host.textContent).not.toContain('Copied');
      expect(logged).toHaveBeenCalledOnce();
      button.click();
      await until('copy retry succeeds', () => button.getAttribute('aria-label') === 'Copy - Copied');
      expect(write).toHaveBeenCalledTimes(2);
    });
  }
});
