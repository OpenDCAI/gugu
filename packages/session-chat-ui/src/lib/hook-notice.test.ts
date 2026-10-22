import { describe, expect, it } from 'vitest';
import { hookSpeakerOfNotice, parseHookNotice } from './hook-notice';

describe('hook notice shapes (#55)', () => {
  it('说话人可带 `:来源` 限定 —— 压缩后的 SessionStart 是 `SessionStart:compact`', () => {
    expect(parseHookNotice('**Notice:** SessionStart:compact says: AutoLibrary · 4 volumes')).toEqual({
      level: 'notice',
      hookName: 'SessionStart:compact',
      body: 'AutoLibrary · 4 volumes',
    });
  });

  it('provider-notice:先认 title,第一行太长时桥换成通用标题,再认 detail', () => {
    expect(hookSpeakerOfNotice({ title: 'Stop says: ⏸ 收尾自检', detail: 'Stop says: ⏸ 收尾自检' })).toBe('Stop');
    expect(hookSpeakerOfNotice({ title: 'Claude reported a notice', detail: 'Stop says: long' })).toBe('Stop');
  });

  it('❌ 不是钩子的提示认不出', () => {
    expect(hookSpeakerOfNotice({ title: 'Model fallback', detail: 'claude-a declined this request; retried with claude-b.' })).toBeNull();
    expect(hookSpeakerOfNotice({ title: 'Task stopped by user', detail: 'sleep 613.' })).toBeNull();
  });
});
