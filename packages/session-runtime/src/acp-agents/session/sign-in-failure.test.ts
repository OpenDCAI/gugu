import { describe, expect, it } from 'vitest';
import { isSignInFailure } from '@gugu/session-core/acp';
import { classifyTurnFailure } from './turn-failure';

// d22 真机日志里那一条(2026-09-24):refresh token 已失效,凭据文件还在。
const CODEX_REFRESH_DEAD = {
  name: 'RequestError',
  message: 'Your access token could not be refreshed. Please log out and sign in again.',
  code: -32603,
  data: {
    message: 'Your access token could not be refreshed. Please log out and sign in again.',
    codexErrorInfo: 'unauthorized',
  },
};

// F83 mac1 真机那一条(2026-09-30):自家 Claude 登录被拒 403,桥把 SDK 的错误类别放进 data.errorKind。
const CLAUDE_403 = {
  name: 'RequestError',
  message: 'Internal error: Failed to authenticate. API Error: 403 Request not allowed',
  code: -32603,
  data: { errorKind: 'authentication_failed' },
};

describe('isSignInFailure (#6264)', () => {
  it('认 codex 桥带出来的 codexErrorInfo=unauthorized(d22 真机那一条)', () => {
    expect(isSignInFailure(CODEX_REFRESH_DEAD)).toBe(true);
  });

  it('认 codex 0.156 路由发现被 401 拒的那一条(codex 自己分成 other,只认它写出的「unauthorized (401)」)', () => {
    expect(
      isSignInFailure({
        name: 'RequestError',
        message: 'workspace routing discovery unauthorized (401)',
        code: -32603,
        data: { message: 'workspace routing discovery unauthorized (401)', codexErrorInfo: 'other' },
      })
    ).toBe(true);
    // 同一步因网络/地区失败(实测 403 地区封锁时就是这一句):不算登录失效。
    expect(
      isSignInFailure({
        name: 'RequestError',
        message: 'workspace routing discovery failed',
        code: -32603,
        data: { message: 'workspace routing discovery failed', codexErrorInfo: 'other' },
      })
    ).toBe(false);
  });

  it('认 Claude 桥带出来的 errorKind:authentication_failed / oauth_org_not_allowed(F83 mac1 真机那一条)', () => {
    expect(isSignInFailure(CLAUDE_403)).toBe(true);
    expect(isSignInFailure({ ...CLAUDE_403, data: { errorKind: 'oauth_org_not_allowed' } })).toBe(true);
  });

  it('Claude 桥说 /login 修不好的那几类(verification_required、cloud_credential_error)和限流不算', () => {
    for (const errorKind of ['verification_required', 'cloud_credential_error', 'rate_limit', 'billing_error']) {
      expect(isSignInFailure({ ...CLAUDE_403, data: { errorKind } })).toBe(false);
    }
  });

  it('认 ACP 协议的 authRequired(-32000),claude 的「Session expired」走的就是它', () => {
    expect(isSignInFailure({ name: 'RequestError', message: 'Authentication required', code: -32000 })).toBe(true);
  });

  it('认平铺出来的 HTTP 401', () => {
    expect(isSignInFailure({ name: 'RequestError', message: 'x', code: -32603, data: { httpStatusCode: 401 } })).toBe(true);
  });

  it('❌ 不按句子猜:同样说「log out and sign in again」、但没有结构化信号的,不算', () => {
    expect(
      isSignInFailure({ name: 'Error', message: 'Your access token could not be refreshed. Please log out and sign in again.' })
    ).toBe(false);
  });

  it('其它 codex 失败分类(限流、额度)不算', () => {
    expect(isSignInFailure({ name: 'RequestError', message: 'x', code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } })).toBe(false);
    expect(isSignInFailure({ name: 'RequestError', message: 'x', code: -32603, data: { httpStatusCode: 429 } })).toBe(false);
    expect(isSignInFailure({ name: 'RequestError', message: 'x', code: -32603, data: 'plain' })).toBe(false);
  });
});

describe('classifyTurnFailure 带出 signInRequired', () => {
  it('登录失效的那一轮:reason 仍是 prompt_failed,多一格 signInRequired,原话照留', () => {
    const { outcome, provisional } = classifyTurnFailure({ at: 'prompt', cause: CODEX_REFRESH_DEAD });
    expect(outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed', signInRequired: true });
    expect(outcome.kind === 'error' && outcome.detail).toContain('could not be refreshed');
    expect(provisional).toBe(false);
  });

  it('Claude 桥的 authentication_failed 同样带出 signInRequired —— claude 这才会被标成「登录已失效」(F83)', () => {
    const { outcome } = classifyTurnFailure({ at: 'prompt', cause: CLAUDE_403 });
    expect(outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed', signInRequired: true });
  });

  it('跑咕咕平台模型的会话被鉴权拒:说的是平台那一侧,不带这一格', () => {
    const { outcome } = classifyTurnFailure({ at: 'prompt', cause: CODEX_REFRESH_DEAD, platformCredentials: true });
    expect(outcome).not.toHaveProperty('signInRequired');
  });

  it('普通失败不带这一格', () => {
    const { outcome } = classifyTurnFailure({
      at: 'prompt',
      cause: { name: 'RequestError', message: 'Input too large', code: -32603, data: { input_error_code: 'input_too_large' } },
    });
    expect(outcome).not.toHaveProperty('signInRequired');
  });
});
