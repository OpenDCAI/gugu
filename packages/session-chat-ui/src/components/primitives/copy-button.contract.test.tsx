/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import { CopyButton } from './CopyButton';

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { dispose?.(); host?.remove(); vi.restoreAllMocks(); });

describe('clipboard rejection feedback', () => {
  for (const variant of ['inline', 'overlay'] as const) {
    it(`shows the sanitized cause on the ${variant} button and clears it on retry`, async () => {
      const write = vi.spyOn(navigator.clipboard, 'writeText')
        .mockRejectedValueOnce(new Error('Clipboard permission denied for /Users/alice/private.txt with sk-private_token\nprivate stack'))
        .mockResolvedValueOnce();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      host = document.createElement('div');
      document.body.appendChild(host);
      dispose = render(() => <CopyButton text="message" variant={variant} />, host);
      const button = host.querySelector('button')!;
      button.click();
      await until('copy failure appears', () => host!.querySelector('[role="alert"]') !== null);
      const expected = 'Could not copy: Clipboard permission denied for [path] with [redacted token]';
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(expected);
      expect(button.getAttribute('aria-label')).toBe(expected);
      expect(button.title).toBe(expected);
      expect(host.textContent).not.toContain('Copied');
      expect(logged).toHaveBeenCalledOnce();
      button.click();
      await until('copy retry succeeds', () => button.getAttribute('aria-label') === 'Copy - Copied!');
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(write).toHaveBeenCalledTimes(2);
    });
  }
});
