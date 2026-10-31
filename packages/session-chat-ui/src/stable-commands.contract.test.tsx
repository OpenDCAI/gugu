/** @jsxImportSource solid-js */
// @@@stable-commands: a host re-render hands the view fresh callbacks; the rows must not see a new commands object
// (each new one re-laid-out the whole transcript), yet a click must still reach the host's latest callback.
import { describe, expect, it, vi } from 'vitest';
import { sameCommandShape, stableCommands } from '@session-chat/chat-view';
import type { ChatCommands } from '@session-chat/commands';

describe('stable chat commands', () => {
  it('fresh callbacks with the same commands present are the same shape; a value command or a new command is not', () => {
    const editing = { itemId: 'm1', text: 'hi' } as unknown as ChatCommands['editingMessage'];
    const a: ChatCommands = { onStop: () => {}, editingMessage: editing };
    expect(sameCommandShape(a, { onStop: () => {}, editingMessage: editing })).toBe(true);
    expect(sameCommandShape(a, { onStop: () => {}, editingMessage: editing, onCopyError: undefined })).toBe(true);
    expect(sameCommandShape(a, { onStop: () => {}, editingMessage: { ...(editing as object) } as ChatCommands['editingMessage'] })).toBe(false);
    expect(sameCommandShape(a, { onStop: () => {}, editingMessage: editing, onOpenLink: () => true })).toBe(false);
    expect(sameCommandShape(a, { editingMessage: editing })).toBe(false);
  });

  it('a stable command calls whatever the host handed in last', () => {
    let latest: ChatCommands = { onOpenLink: vi.fn(() => false) };
    const stable = stableCommands(latest, () => latest);
    const newer = vi.fn(() => true);
    latest = { onOpenLink: newer };
    expect(stable.onOpenLink?.('https://example.test')).toBe(true);
    expect(newer).toHaveBeenCalledWith('https://example.test');
  });
});
