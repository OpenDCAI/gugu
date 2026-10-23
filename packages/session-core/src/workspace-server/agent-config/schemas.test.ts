import { describe, expect, it } from 'vitest';
import { agentConfigAuthErrorSchema } from './schemas';

// 开发版的线上校验会解析输出,zod 默认丢掉不认识的键:`sessionsBusy` 没写进 schema,界面就永远收不到「哪一家、几个」。
describe('agent-config invalid-state error on the wire', () => {
  it('keeps which provider has how many sessions working', () => {
    const wire = { type: 'invalid-state', message: '2 Codex sessions are still working.', sessionsBusy: { providerId: 'codex', count: 2 } };
    expect(agentConfigAuthErrorSchema.parse(wire)).toEqual(wire);
  });

  it('still accepts the plain message an older host sends', () => {
    const wire = { type: 'invalid-state', message: 'login missing' };
    expect(agentConfigAuthErrorSchema.parse(wire)).toEqual(wire);
  });
});
