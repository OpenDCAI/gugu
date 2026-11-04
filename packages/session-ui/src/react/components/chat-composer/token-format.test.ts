import { describe, expect, it } from 'vitest';
import { formatTokenCount } from '@gugu/session-shared/format';
import { formatContextWindow } from './composer-model-menu';
import { formatTokens } from './context-usage-indicator';

describe('token 数量的千/兆边界', () => {
  it('四舍五入到千之后满 1000 就进位到 M,不写「1000k」「1000.0k」', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(999_400)).toBe('999k');
    expect(formatTokenCount(999_950)).toBe('1.0M');
    expect(formatTokenCount(999_999)).toBe('1.0M');
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_234_500)).toBe('1.2M');
  });

  it('上下文指示器与模型 tooltip 用的就是同一份判据', () => {
    expect(formatTokens(999_600)).toBe('1.0M');
    expect(formatTokens(999_400)).toBe('999k');
    expect(formatContextWindow(999_600)).toBe('1M tokens');
    expect(formatContextWindow(200_000)).toBe('200K tokens');
  });
});
