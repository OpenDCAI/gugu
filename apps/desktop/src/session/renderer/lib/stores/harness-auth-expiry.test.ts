import { describe, expect, it } from 'vitest';
import { expiredProviderIds, isAuthExpired, lastTurnSignInRequired, withAuthExpiry } from './harness-auth-expiry';

const expired = { status: { kind: 'unauthenticated' as const, reason: 'expired' as const }, login: null };
const signedOut = { status: { kind: 'unauthenticated' as const }, login: null };
const signedIn = { status: { kind: 'authenticated' as const }, login: null };
const efforts = [{ id: 'high', name: 'High' }];

describe('#6264 登录已失效在界面上的读法', () => {
  it('只有 reason=expired 才算', () => {
    expect(isAuthExpired(expired)).toBe(true);
    expect(isAuthExpired(signedOut)).toBe(false);
    expect(isAuthExpired(signedIn)).toBe(false);
    expect(isAuthExpired(null)).toBe(false);
  });

  it('目录说 ready 而登录已失效:自家那组按「没登录」处理,档位照留,带 expired', () => {
    const ready = { kind: 'ready' as const, models: [{ id: 'gpt', name: 'GPT' }], selected: 'gpt', efforts, selectedEffort: 'high' };
    expect(withAuthExpiry(ready, true)).toEqual({ kind: 'auth-required', authMethods: [], efforts, selectedEffort: 'high', expired: true });
    expect(withAuthExpiry(ready, false)).toBe(ready);
  });

  it('本来就是 auth-required:只多一格 expired;没装 / 读不出这几态不动', () => {
    const authRequired = { kind: 'auth-required' as const, authMethods: [], efforts, selectedEffort: null };
    expect(withAuthExpiry(authRequired, true)).toEqual({ ...authRequired, expired: true });
    expect(withAuthExpiry({ kind: 'not-installed' }, true)).toEqual({ kind: 'not-installed' });
    expect(withAuthExpiry({ kind: 'unavailable', reason: 'x' }, true)).toEqual({ kind: 'unavailable', reason: 'x' });
  });

  it('网格一次读出哪几家失效', () => {
    expect([...expiredProviderIds({ codex: { auth: expired }, claude: { auth: signedIn }, kimi: undefined })]).toEqual(['codex']);
  });

  it('最近一轮因登录失效而失败才算;之后又有一轮就不算', () => {
    const failed = { outcome: { kind: 'error' as const, signInRequired: true } };
    expect(lastTurnSignInRequired([failed])).toBe(true);
    expect(lastTurnSignInRequired([failed, { outcome: { kind: 'done' as const } }])).toBe(false);
    expect(lastTurnSignInRequired([{ outcome: { kind: 'error' as const } }])).toBe(false);
    expect(lastTurnSignInRequired([])).toBe(false);
  });
});
