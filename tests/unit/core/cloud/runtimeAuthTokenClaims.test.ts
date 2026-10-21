import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessTokenExpirySeconds, userIdFromSupabaseAccessToken } from '../../../../packages/core/src/cloud/runtimeAuthProvider';

/** A JWT the way GoTrue writes one: base64url, no padding. The signature is never read here. */
function jwt(claims: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.c2ln`;
}

describe('token claims, without Node (the phone reads tokens in its outer page, where there is no Buffer)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads sub and exp from base64url, padding or not, non-ASCII included', () => {
    // A payload whose base64url uses both - and _ and needs padding back.
    const claims = { sub: '9d377e8d-54e1-4feb-ab98-0ff64ab0771a', exp: 1790679999, name: '咕咕 ??>>' };
    const token = jwt(claims);
    expect(token.split('.')[1]).toMatch(/[-_]/);
    vi.stubGlobal('Buffer', undefined);
    expect(userIdFromSupabaseAccessToken(token)).toBe(claims.sub);
    expect(accessTokenExpirySeconds(token)).toBe(claims.exp);
  });

  it('answers null for what is not a token', () => {
    const noSub = jwt({ exp: 1 });
    vi.stubGlobal('Buffer', undefined);
    expect(userIdFromSupabaseAccessToken('not-a-token')).toBeNull();
    expect(userIdFromSupabaseAccessToken('a.%%%.c')).toBeNull();
    expect(userIdFromSupabaseAccessToken(noSub)).toBeNull();
  });
});
