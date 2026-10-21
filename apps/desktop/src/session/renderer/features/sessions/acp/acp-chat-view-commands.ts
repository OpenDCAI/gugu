import type { ChatView, ChatViewCommandId } from '@renderer/lib/chat/chat-transcript';

type ChatShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
> &
  Pick<KeyboardEvent, 'target' | 'composedPath'>;

function isEditableKeyboardTarget(event: ChatShortcutEvent): boolean {
  const path = event.composedPath?.() ?? (event.target ? [event.target] : []);
  return path.some(
    (target) => {
      const closest = (target as { closest?: unknown }).closest;
      return (
        typeof closest === 'function' &&
        closest.call(
          target,
          'input, textarea, select, [contenteditable="true"], [role="textbox"]',
        ) !== null
      );
    },
  );
}

export function chatViewCommandForShortcut(event: ChatShortcutEvent): ChatViewCommandId | null {
  if (
    event.isComposing ||
    isEditableKeyboardTarget(event) ||
    event.altKey ||
    event.shiftKey ||
    (!event.metaKey && !event.ctrlKey)
  ) {
    return null;
  }

  switch (event.key) {
    case 'ArrowUp':
      return 'chat.scrollToTop';
    case 'ArrowDown':
      return 'chat.scrollToBottom';
    default:
      return null;
  }
}

export function executeChatViewCommand(
  view: ChatView | null,
  commandId: ChatViewCommandId
): boolean {
  if (!view) return false;

  switch (commandId) {
    case 'chat.scrollToTop':
      view.scrollToTop({ behavior: 'smooth' });
      return true;
    case 'chat.scrollToBottom':
      view.scrollToBottom({ behavior: 'smooth' });
      return true;
  }
}
