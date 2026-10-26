import { safeFailureLine, consoleLogger } from '@gugu/session-core/lib';
import type { ChatTranslator } from '@session-chat/localization';
/** Copy feedback shared by transcript buttons; preserve the native user gesture and dispose the reset timer. */

import { createSignal, onCleanup } from 'solid-js';

export type ClipboardState = {
  copied: () => boolean;
  failed: () => string | null;
  copy: (text: string) => void;
};

export function createClipboard(translate: ChatTranslator, resetMs = 1500): ClipboardState {
  const [copied, setCopied] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: unknown) => {
    consoleLogger.error('Clipboard write failed', error);
    setFailed(`${translate('transcript.copyFailed')}: ${safeFailureLine(String((error as Error)?.message ?? error), () => translate('taskError.connectionLost'))}`);
  };

  const copy = (text: string): void => {
    if (resetTimer !== undefined) { clearTimeout(resetTimer); resetTimer = undefined; }
    setFailed(null);
    setCopied(false);
    try {
      void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (resetTimer !== undefined) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        setCopied(false);
        resetTimer = undefined;
      }, resetMs);
    }).catch(fail);
    } catch (error) { fail(error); }
  };

  onCleanup(() => {
    if (resetTimer !== undefined) clearTimeout(resetTimer);
  });

  return { copied, failed, copy };
}
