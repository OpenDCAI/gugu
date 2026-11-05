import { describe, expect, it } from 'vitest';
import { formatTokens } from './compaction.def';

describe('压缩行的 token 写法', () => {
  it('进位判据与消息区其它地方一致(999,950 → 1.0M,不再出现 1000.0k)', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(75_888)).toBe('76k');
    expect(formatTokens(999_400)).toBe('999k');
    expect(formatTokens(999_950)).toBe('1.0M');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});
