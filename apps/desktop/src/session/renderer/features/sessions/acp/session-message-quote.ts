import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote';

/** Only the authored body returns to an editor; persisted sources remain in the transcript. */
export const sessionPromptBody = (text: string): string => readMessageQuote(text)?.body ?? text;

/** Undefined: this row has no selection. Null: a selection crosses message boundaries. */
export function selectedMessageText(root: HTMLElement, selection: Selection | null): string | null | undefined {
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return undefined;
  const start = root.contains(selection.anchorNode), end = root.contains(selection.focusNode);
  if (start && end) return selection.toString();
  return start || end || selection.getRangeAt(0).intersectsNode(root) ? null : undefined;
}
