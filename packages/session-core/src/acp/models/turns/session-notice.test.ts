import { describe, expect, it } from 'vitest';
import { hookSpeakerOfNotice } from './session-notice';

const notice = (title: string, detail = title) => ({ code: 'provider-notice' as const, title, detail });

describe('hookSpeakerOfNotice (#55)', () => {
  it('一行的钩子输出:title = detail', () => {
    expect(hookSpeakerOfNotice(notice('Stop says: ⏸ 收尾自检'))).toBe('Stop');
  });

  it('多行:title 是第一行、detail 是其余几行,每一行同一个说话人', () => {
    expect(hookSpeakerOfNotice(notice('SessionStart:compact says: AutoLibrary', 'SessionStart:compact says:   ├ workspace\nSessionStart:compact says:   └ ideas'))).toBe('SessionStart:compact');
  });

  it('第一行太长时桥换了通用标题,整段在 detail 里', () => {
    expect(hookSpeakerOfNotice(notice('Claude reported a notice', `Stop says: ${'x'.repeat(300)}`))).toBe('Stop');
  });

  it('❌ 不是钩子:普通提示、只有第一行像、换了说话人、不是 provider-notice', () => {
    expect(hookSpeakerOfNotice(notice('Model fallback', 'claude-a declined this request; retried with claude-b.'))).toBeNull();
    expect(hookSpeakerOfNotice(notice('Task stopped by user', 'sleep 613.'))).toBeNull();
    expect(hookSpeakerOfNotice(notice('Anthropic API says: overloaded', 'retrying in 5s'))).toBeNull();
    expect(hookSpeakerOfNotice(notice('Stop says: a', 'PostToolUse says: b'))).toBeNull();
    expect(hookSpeakerOfNotice({ code: 'model-unavailable', title: 'Stop says: x', detail: 'Stop says: x' })).toBeNull();
  });
});
