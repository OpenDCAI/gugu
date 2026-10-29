import { describe, expect, it, vi } from 'vitest';
import { readMessageQuote } from '@gugu/core/shared/ui/messageQuote';
import { consumeSessionQuote, getSessionQuote, quotedSessionPrompt, restoreSessionQuote, setSessionQuote, subscribeSessionQuote } from './session-quote-draft';

const first = { source: { kind: 'session' as const, sessionId: 'task', itemId: 'first' }, text: 'same words', sender: 'Agent' };
describe('task quote admission', () => {
  it('serializes only the captured quote and does not clear a newer quote chosen during upload', () => {
    const store = {}, otherTask = {}, changed = vi.fn();
    const unsubscribe = subscribeSessionQuote(store, changed);
    setSessionQuote(store, first);
    const captured = getSessionQuote(store);
    const second = { ...first, source: { ...first.source, itemId: 'second' } };
    setSessionQuote(store, second);
    expect(readMessageQuote(quotedSessionPrompt('question', captured))).toMatchObject({ source: first.source, body: 'question' });
    consumeSessionQuote(store, captured);
    expect(getSessionQuote(store)).toBe(second);
    expect(getSessionQuote(otherTask)).toBeNull();
    consumeSessionQuote(store, second);
    expect(getSessionQuote(store)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    setSessionQuote(store, first);
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it('restores an unsent prompt and leaves plain blockquotes alone', () => {
    const store = {};
    expect(restoreSessionQuote(store, quotedSessionPrompt('question', first))).toBe('question');
    expect(getSessionQuote(store)).toEqual(first);
    expect(restoreSessionQuote(store, '> plain words\n\nquestion')).toBe('> plain words\n\nquestion');
    expect(getSessionQuote(store)).toBeNull();
  });
});
