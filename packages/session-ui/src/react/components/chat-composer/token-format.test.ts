import { describe, expect, it } from 'vitest';
import { formatContextWindow } from './composer-model-menu';
import { formatTokens } from './context-usage-indicator';

describe('token 数量的千/兆边界', () => {
  it('四舍五入到千之后满 1000 就进位到 M,不写「1000k」「1000K tokens」', () => {
    expect(formatTokens(999_400)).toBe('999k');
    expect(formatTokens(999_600)).toBe('1.0M');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatContextWindow(999_600)).toBe('1M tokens');
    expect(formatContextWindow(200_000)).toBe('200K tokens');
  });
});
