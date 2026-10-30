import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ChatCommands } from '@gugu/session-chat-ui';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { showRendererContentMenu } from '@/lib/contentContextMenu';
import { rendererLogger } from '@/lib/log';
import { platform } from '@/platform';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AcpChatStore } from './acp-chat-store';
import { selectedMessageText, sessionMessageQuoteSource } from './session-message-quote';
import { restoreSessionQuote, setSessionQuote } from './session-quote-draft';

type Target = Parameters<NonNullable<ChatCommands['onMessageTextMount']>>[0];
const log = rendererLogger('session/message-quotes');

/** Whole-message quotes keep their source; selected-text sending stays disabled until compatible receivers ship. */
export function useSessionMessageQuotes(store: AcpChatStore | null | undefined, editor: MutableRefObject<PromptEditorRef | null>) {
  const { translate } = useSessionMessages();
  const latest = useRef({ store, translate });
  latest.current = { store, translate };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const restorePrompt = useCallback(({ text }: { text: string }) => {
    const current = latest.current.store;
    if (!current) return;
    const body = restoreSessionQuote(current, text);
    current.setDraftText(body);
    editor.current?.setText(body);
    editor.current?.focus('end');
  }, [editor]);
  const onMessageTextMount = useCallback((target: Target) => {
    const open = (event: MouseEvent) => {
      const current = latest.current.store;
      if (!current) return;
      const selection = selectedMessageText(target.root, target.root.ownerDocument.getSelection());
      if (selection === null) return;
      if (selection === undefined && (event.target as Element | null)?.closest?.('a,button,input,textarea,[contenteditable],img')) return;
      const message = target.message();
      const source = sessionMessageQuoteSource(message, current.sessionId);
      const text = selection ?? message.text;
      if (!text.trim()) return;
      // Snapshot before the menu takes focus or virtualization reuses the row.
      const sender = target.sender?.() ?? '';
      const t = latest.current.translate;
      event.preventDefault();
      event.stopPropagation();
      const canQuote = source !== null && selection === undefined;
      void showRendererContentMenu([
        ...(canQuote ? [{ id: 'quote', label: t('transcript.quoteMessage'), icon: 'quote' } as const, { type: 'separator' } as const] : []),
        { id: 'copy', label: t(selection === undefined ? 'transcript.copyMessage' : 'transcript.copySelection') },
      ], { x: event.clientX, y: event.clientY }).then(async action => {
        if (!alive.current || latest.current.store !== current) return;
        if (action === 'quote' && canQuote && source) {
          setSessionQuote(current, { source, text, sender });
          editor.current?.focus('end');
        } else if (action === 'copy') {
          await platform.writeClipboardText(text);
          toast({ title: t('transcript.copied') });
        }
      }).catch(error => {
        log.error({ error }, 'Message quote menu failed');
        toast({ title: t('task.copyFailed'), tier: 'error' });
      });
    };
    target.root.addEventListener('contextmenu', open);
    return () => target.root.removeEventListener('contextmenu', open);
  }, [editor]);
  return { onMessageTextMount, restorePrompt };
}
