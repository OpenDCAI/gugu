// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { selectedMessageText } from './session-message-quote';

describe('message text selection', () => {
  it('reads a selection only from the same message and refuses selections crossing messages', () => {
    document.body.innerHTML = '<div id="a">same words</div><div id="b">same words</div>';
    const a = document.getElementById('a')!, b = document.getElementById('b')!;
    const range = document.createRange(), selection = document.getSelection()!;
    range.setStart(a.firstChild!, 0); range.setEnd(a.firstChild!, 4);
    selection.removeAllRanges(); selection.addRange(range);
    expect(selectedMessageText(a, selection)).toBe('same');
    expect(selectedMessageText(b, selection)).toBeUndefined();
    range.setEnd(b.firstChild!, 4); selection.removeAllRanges(); selection.addRange(range);
    expect(selectedMessageText(a, selection)).toBeNull();
    selection.removeAllRanges();
  });
});
