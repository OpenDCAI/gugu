import { describe, expect, it } from 'vitest';
import { bridgeFailure, pageArgument } from './bridge-protocol';

// L11 B3: the bounds the host puts on a page's argument were written twice — the desktop's bridge (extension-bridge.ts)
// and the phone's host (phoneAppHost.ts) — and had drifted (an empty title was `failed` on the desktop, `invalid` on the
// phone; the phone's clipboard refusal did not say the limit). One rule now, both call it.

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return { code: bridgeFailure(error).code, message: (error as Error).message };
  }
  return null;
};

describe('pageArgument: one rule for the desktop and the phone', () => {
  it('a title: trimmed, at most 48 characters; an empty one is refused invalid', () => {
    expect(pageArgument('setTabTitle', { title: '  Votes  ' })).toBe('Votes');
    expect(pageArgument('setTabTitle', { title: 'x'.repeat(60) })).toBe('x'.repeat(48));
    expect(refusal(() => pageArgument('setTabTitle', { title: '   ' }))).toEqual({ code: 'invalid', message: 'Title is required' });
  });

  it('a badge: a number stays a number, anything else at most 8 characters, nothing clears it', () => {
    expect(pageArgument('setTabBadge', { badge: 12 })).toBe(12);
    expect(pageArgument('setTabBadge', { badge: 'unread-messages' })).toBe('unread-m');
    expect(pageArgument('setTabBadge', { badge: null })).toBeNull();
    expect(pageArgument('setTabBadge', {})).toBeNull();
  });

  it('the clipboard: a string, up to 8 Mi characters; anything else is refused invalid, saying the limit', () => {
    expect(pageArgument('clipboardWriteText', { text: 'copy me' })).toBe('copy me');
    const tooLong = refusal(() => pageArgument('clipboardWriteText', { text: 'x'.repeat(8 * 1024 * 1024 + 1) }));
    expect(tooLong).toEqual({ code: 'invalid', message: 'clipboard.writeText takes a string of at most 8388608 characters' });
    expect(refusal(() => pageArgument('clipboardWriteText', { text: 42 }))?.code).toBe('invalid');
  });
});
