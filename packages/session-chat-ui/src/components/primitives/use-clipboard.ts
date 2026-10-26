import { consoleLogger } from '@gugu/session-core/lib';
/** Copy feedback shared by transcript buttons; preserve the native user gesture and dispose the reset timer. */

import { createSignal, onCleanup } from 'solid-js';

export type ClipboardState = {
  copied: () => boolean;
  copy: (text: string) => void;
};

export function createClipboard(onError: (error: unknown) => void, resetMs = 1500): ClipboardState {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const copy = async (text: string): Promise<void> => {
    if (resetTimer !== undefined) { clearTimeout(resetTimer); resetTimer = undefined; }
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer !== undefined) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        setCopied(false);
        resetTimer = undefined;
      }, resetMs);
    } catch (error) { consoleLogger.error('Clipboard write failed', error); onError(error); }
  };

  onCleanup(() => {
    if (resetTimer !== undefined) clearTimeout(resetTimer);
  });

  return { copied, copy };
}
