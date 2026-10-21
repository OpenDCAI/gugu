import { describe, expect, it } from 'vitest';
import { NOT_BROWSING, stepPromptHistory, type PromptHistoryBrowse } from './prompt-history-keymap';

const HISTORY = ['first', 'second', 'third'];

describe('prompt history walk', () => {
  it('starts at the newest prompt and preserves the draft', () => {
    expect(stepPromptHistory('older', NOT_BROWSING, HISTORY, 'half typed')).toEqual({
      browse: { index: 2, draft: 'half typed' },
      text: 'third',
    });
  });

  it('walks to the oldest prompt and stays there', () => {
    const at2: PromptHistoryBrowse = { index: 2, draft: 'd' };
    expect(stepPromptHistory('older', at2, HISTORY, 'third')?.text).toBe('second');
    expect(stepPromptHistory('older', { index: 1, draft: 'd' }, HISTORY, 'second')?.text).toBe('first');
    expect(stepPromptHistory('older', { index: 0, draft: 'd' }, HISTORY, 'first')).toEqual({
      browse: { index: 0, draft: 'd' },
      text: null,
    });
  });

  it('keeps bare newer arrows with the caret until a history walk is active', () => {
    expect(stepPromptHistory('newer', NOT_BROWSING, HISTORY, 'draft')).toBeNull();
    expect(stepPromptHistory('newer', { index: 0, draft: 'd' }, HISTORY, 'first')?.text).toBe('second');
  });

  it('restores the draft when newer reaches the end of the walk', () => {
    expect(stepPromptHistory('newer', { index: 2, draft: 'half typed' }, HISTORY, 'third')).toEqual({
      browse: NOT_BROWSING,
      text: 'half typed',
      restoresDraft: true,
    });
  });
});
