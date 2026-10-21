import { describe, expect, it } from 'vitest';
import { mimocodeFailureFromStderrLine } from './turn-failure';

// 原样取自 10-07 mac1 `mimo acp --print-logs`(没有凭据)的 stderr。
const PROCESSOR = 'ERROR 2026-10-07T12:06:43 +1ms service=session.processor session.id=ses_-ffe5ee9bdbf1dffe8Sjv5kAbD messageID=msg_g001a11642416d001SpI839Z76 error=Invalid API Key stack=AI_APICallError: Invalid API Key';
const LLM = 'ERROR 2026-10-07T12:06:43 +33ms service=llm providerID=xiaomi modelID=mimo-v2.5-pro-ultraspeed session.id=ses_x small=false agent=build mode=primary error={"error":{"name":"AI_APICallError","url":"https://api.xiaomimimo.com/v1/chat/completions"}}';

describe('mimocodeFailureFromStderrLine', () => {
  it('处理这一轮的那一层报的错:原话,凭据类带 signInRequired', () => {
    expect(mimocodeFailureFromStderrLine(PROCESSOR)).toEqual({ message: 'Invalid API Key', signInRequired: true });
  });

  it('别的失败照原话,不说成登录问题', () => {
    expect(mimocodeFailureFromStderrLine(
      'ERROR 2026-10-07T12:06:43 +1ms service=session.processor session.id=s messageID=m error=Model not found: xiaomi/x stack=ProviderModelNotFoundError'
    )).toBe('Model not found: xiaomi/x');
  });

  it('service=llm 那几行(拟标题也走这里)与非 ERROR 行:不认', () => {
    expect(mimocodeFailureFromStderrLine(LLM)).toBeNull();
    expect(mimocodeFailureFromStderrLine('WARN  2026-10-07T12:06:07 +0ms service=skill name=x duplicate skill name')).toBeNull();
  });
});
