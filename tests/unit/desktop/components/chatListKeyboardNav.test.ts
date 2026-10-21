import { describe, expect, it } from 'vitest';
import { chatListShortcutFor, nextChatId } from '../../../../apps/desktop/src/components/chat-list-keyboard-nav';

describe('chat list keyboard navigation', () => {
  it('uses modified arrows, while bare or composing arrows remain with the focused control', () => {
    const modified = { key: 'ArrowDown', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(chatListShortcutFor(modified)).toEqual({ kind: 'move', direction: 1 });
    expect(chatListShortcutFor({ ...modified, key: 'ArrowUp' })).toEqual({ kind: 'move', direction: -1 });
    expect(chatListShortcutFor({ ...modified, metaKey: false })).toBeNull();
    expect(chatListShortcutFor({ ...modified, isComposing: true })).toBeNull();
  });

  it('follows visible order, selects the appropriate edge, and never wraps', () => {
    const ids = ['pinned', 'first', 'last'];
    expect(nextChatId(ids, null, 1)).toBe('pinned');
    expect(nextChatId(ids, 'pinned', 1)).toBe('first');
    expect(nextChatId(ids, 'first', -1)).toBe('pinned');
    expect(nextChatId(ids, 'last', 1)).toBeNull();
    expect(nextChatId(ids, 'pinned', -1)).toBeNull();
    expect(nextChatId(ids, 'missing', 1)).toBe('pinned');
    expect(nextChatId(ids, 'missing', -1)).toBe('last');
    expect(nextChatId([], null, 1)).toBeNull();
  });
});
