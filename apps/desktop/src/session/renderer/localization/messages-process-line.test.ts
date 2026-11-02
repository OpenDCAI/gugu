import { describe, expect, it } from 'vitest';
import { enUSMessages, zhCNMessages } from './messages';

// owner 2026-10-28:过程行上在跑时写「执行中 · 1m13s · 7 步」,❌「思考执行中」。英文不跟着改。
describe('process line words', () => {
  it('reads 执行中 while a turn runs', () => {
    expect(zhCNMessages['transcript.thinkingLive']).toBe('执行中');
    expect(enUSMessages['transcript.thinkingLive']).toBe('Thinking and working');
  });

  it('names cold recovery in the existing process line without changing a new start', () => {
    expect(zhCNMessages['transcript.restoring']).toBe('恢复中');
    expect(enUSMessages['transcript.restoring']).toBe('Restoring');
    expect(zhCNMessages['transcript.starting']).toBe('启动中');
  });
});
