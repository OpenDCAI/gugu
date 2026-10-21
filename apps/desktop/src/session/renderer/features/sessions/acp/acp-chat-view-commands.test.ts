import { describe, expect, it } from 'vitest';
import { chatViewCommandForShortcut } from './acp-chat-view-commands';

type ShortcutEvent = Parameters<typeof chatViewCommandForShortcut>[0];

const event = (overrides: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key: 'ArrowUp',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  target: null,
  composedPath: () => [],
  ...overrides,
});

describe('acp chat view commands', () => {
  it('maps unclaimed modified arrows and yields to composition', () => {
    expect(chatViewCommandForShortcut(event({ key: 'ArrowUp', metaKey: true }))).toBe(
      'chat.scrollToTop',
    );
    expect(chatViewCommandForShortcut(event({ key: 'ArrowDown', ctrlKey: true }))).toBe(
      'chat.scrollToBottom',
    );
    expect(chatViewCommandForShortcut(event({ key: 'ArrowDown', isComposing: true }))).toBeNull();
    expect(chatViewCommandForShortcut(event({ key: 'ArrowDown', metaKey: true, altKey: true }))).toBeNull();
  });

  it('yields modified arrows to an editable keyboard owner', () => {
    const textarea = {
      closest: (selector: string) => (selector.includes('textarea') ? textarea : null),
    } as unknown as EventTarget;

    expect(
      chatViewCommandForShortcut(event({ key: 'ArrowUp', metaKey: true, target: textarea, composedPath: () => [textarea] })),
    ).toBeNull();
  });
});
