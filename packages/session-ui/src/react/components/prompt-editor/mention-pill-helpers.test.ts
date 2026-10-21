import { describe, expect, it } from 'vitest';
import { compactMentionPath } from './mention-pill-helpers';

describe('compactMentionPath', () => {
  it('keeps the directory tail that distinguishes same-name files', () => {
    expect(compactMentionPath('/workspace/src/components/README.md')).toBe('…/src/components/');
    expect(compactMentionPath('/workspace/docs/README.md')).toBe('workspace/docs/');
  });

  it('returns an empty path for a bare filename', () => {
    expect(compactMentionPath('README.md')).toBe('');
  });
});
