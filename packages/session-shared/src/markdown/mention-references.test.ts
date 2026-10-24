import { describe, expect, it } from 'vitest';
import { markdownMentionReferences } from './dialect';

describe('explicit mention references', () => {
  it('reads addressed names with spaces and escaped brackets with their exact source range', () => {
    const text = 'Ask @[Claude 2](aid:one) and @[Fig \\] 2](<path with spaces>).';
    const refs = markdownMentionReferences(text);
    expect(refs.map(({ label, target }) => ({ label, target }))).toEqual([
      { label: 'Claude 2', target: 'aid:one' },
      { label: 'Fig ] 2', target: 'path with spaces' },
    ]);
    expect(refs.map(({ start, end }) => text.slice(start, end))).toEqual([
      '@[Claude 2](aid:one)', '@[Fig \\] 2](<path with spaces>)',
    ]);
  });

  it('does not treat escaped text, code, images or ordinary links as addressing', () => {
    const text = '\\@[A](aid:a) `[B](aid:b)` `@[C](aid:c)` ![D](aid:d) [E](aid:e)\n```\n@[F](aid:f)\n```';
    expect(markdownMentionReferences(text)).toEqual([]);
  });
});
