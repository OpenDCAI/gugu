import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ChatCommands } from '@gugu/session-chat-ui';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { showRendererContentMenu } from '@/lib/contentContextMenu';
import { rendererLogger } from '@/lib/log';
import { platform } from '@/platform';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AcpChatStore } from './acp-chat-store';
import { selectedMessageText, sessionPromptBody } from './session-message-quote';
import { bindMessageQuoteTouchMenu } from './message-quote-touch-menu';

type Target = Parameters<NonNullable<ChatCommands['onMessageTextMount']>>[0];
const log = rendererLogger('session/message-actions');

/** Copy menus and restoration of previously saved prompts; whole-message quoting has no creation entry. */
export function useSessionMessageQuotes(store: Pick<AcpChatStore, 'sessionId' | 'setDraftText'> | null | undefined, editor: MutableRefObject<PromptEditorRef | null>) {
  const { translate } = useSessionMessages();
  const latest = useRef({ store, translate });
  latest.current = { store, translate };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const restorePrompt = useCallback(({ text }: { text: string }) => {
    const current = latest.current.store;
    if (!current) return;
    const body = sessionPromptBody(text);
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
      const text = selection ?? message.text;
      if (!text.trim()) return;
      // Snapshot before the menu takes focus or virtualization reuses the row.
      const t = latest.current.translate;
      event.preventDefault();
      event.stopPropagation();
      void showRendererContentMenu([
        { id: 'copy', label: t(selection === undefined ? 'transcript.copyMessage' : 'transcript.copySelection') },
      ], { x: event.clientX, y: event.clientY }).then(async action => {
        if (!alive.current || latest.current.store !== current) return;
        if (action === 'copy') {
          await platform.writeClipboardText(text);
          toast({ title: t('transcript.copied') });
        }
      }).catch(error => {
        log.error({ error }, 'Message copy menu failed');
        toast({ title: t('task.copyFailed'), tier: 'error' });
      });
    };
    const menuRoot = target.menuRoot ?? target.root;
    menuRoot.addEventListener('contextmenu', open);
    const unbindTouch = bindMessageQuoteTouchMenu(menuRoot, target.root, ({ x, y }) => {
      open(new MouseEvent('contextmenu', { clientX: x, clientY: y }));
    });
    return () => { menuRoot.removeEventListener('contextmenu', open); unbindTouch(); };
  }, []);
  return { onMessageTextMount, restorePrompt };
}
