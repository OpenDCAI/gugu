import { consoleLogger } from '@gugu/session-core/lib';
/** Copy feedback shared by transcript buttons; preserve the native user gesture and dispose the reset timer. */

import { createSignal, onCleanup } from 'solid-js';
import { useCommands } from '../contexts/CommandsContext';

export type ClipboardState = {
  copied: () => boolean;
  copy: (text: string) => void;
};

export function createClipboard(onError: (error: unknown) => void, resetMs = 1500): ClipboardState {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Solid context, owned by the caller's reactive root.
  const commands = useCommands();
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const copy = async (text: string): Promise<void> => {
    if (resetTimer !== undefined) { clearTimeout(resetTimer); resetTimer = undefined; }
    setCopied(false);
    try {
      const write = commands().writeClipboardText;
      if (!write) throw new Error('The transcript host does not provide clipboard writing');
      await write(text);
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
