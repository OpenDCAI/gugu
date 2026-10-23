import { describe, expect, it } from 'vitest';
import { parseHookNotice } from './hook-notice';

describe('parseHookNotice (#55)', () => {
  it('说话人可带 `:来源` 限定 —— 压缩后的 SessionStart 是 `SessionStart:compact`', () => {
    expect(parseHookNotice('**Notice:** SessionStart:compact says: AutoLibrary · 4 volumes')).toEqual({
      level: 'notice',
      hookName: 'SessionStart:compact',
      body: 'AutoLibrary · 4 volumes',
    });
  });
});
