import { safeFailureLine, consoleLogger } from '@gugu/session-core/lib';
import { useChatTranslator } from '@session-chat/localization';
/**
 * createClipboard — Solid primitive for copy-to-clipboard interactions.
 *
 * Returns { copied, copy } where:
 *   copied — a reactive accessor; true for `resetMs` ms after a successful copy.
 *   copy   — async function that writes text to the clipboard and sets copied.
 *
 * The reset timer is cleaned up on component disposal via onCleanup.
 *
 * @example
 * const { copied, copy } = createClipboard();
 * <button onClick={() => copy(text)}>
 *   {copied() ? 'Copied!' : 'Copy'}
 * </button>
 */

import { createSignal, onCleanup } from 'solid-js';

export type ClipboardState = {
  copied: () => boolean;
  failed: () => string | null;
  copy: (text: string) => void;
};

export function createClipboard(resetMs = 1500): ClipboardState {
  const [copied, setCopied] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  const translate = useChatTranslator();
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const copy = (text: string): void => {
    if (resetTimer !== undefined) { clearTimeout(resetTimer); resetTimer = undefined; }
    setFailed(null);
    setCopied(false);
    void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => {
      setCopied(true);
      if (resetTimer !== undefined) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        setCopied(false);
        resetTimer = undefined;
      }, resetMs);
    }).catch((error: unknown) => {
      consoleLogger.error('Clipboard write failed', error);
      setFailed(`${translate('transcript.copyFailed')}: ${safeFailureLine(String((error as Error)?.message ?? error), () => translate('taskError.connectionLost'))}`);
    });
  };

  onCleanup(() => {
    if (resetTimer !== undefined) clearTimeout(resetTimer);
  });

  return { copied, failed, copy };
}
