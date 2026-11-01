import type { AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { applyAuthExpiry, applyCredentialExpiry } from './auth-expiry';

/**
 * 「登录已失效」标记与 CLI 读数怎么合(#6264;#1163 加的那一格)。
 *
 * 这一格是纯函数,却决定界面说什么、以及新会话的默认模型落在谁家 —— 所以按真假表钉,而不是只测改动那一格。
 */
describe('applyAuthExpiry', () => {
  it('订阅登录被拒:说「登录已失效」', () => {
    expect(applyAuthExpiry({ kind: 'authenticated', account: 'ada@example.com' }, true)).toEqual({
      kind: 'unauthenticated',
      reason: 'expired',
    });
    expect(
      applyAuthExpiry({ kind: 'authenticated', credentialKind: 'subscription' }, true)
    ).toEqual({ kind: 'unauthenticated', reason: 'expired' });
  });

  it('判不出 + 标着 ⇒ 失效(照旧)', () => {
    expect(applyAuthExpiry({ kind: 'unknown' }, true)).toEqual({
      kind: 'unauthenticated',
      reason: 'expired',
    });
  });

  it('CLI 自己说没登录时照它说,不叠「失效」', () => {
    expect(applyAuthExpiry({ kind: 'unauthenticated' }, true)).toEqual({ kind: 'unauthenticated' });
    expect(applyAuthExpiry({ kind: 'unauthenticated', message: 'no key' }, true)).toEqual({
      kind: 'unauthenticated',
      message: 'no key',
    });
  });

  it('没标着时原样返回', () => {
    const reading: AgentAuthStatus = { kind: 'authenticated', account: 'ada@example.com' };
    expect(applyAuthExpiry(reading, false)).toBe(reading);
  });

  /**
   * #1163 凭据是**用户自己递进来的**(API key / 中转令牌)时不说「登录已失效」:这一格说的是
   * 「这份 Anthropic 登录不能用了,去重新登录」,而这类用户手上没有可续的登录。说错的代价不只是措辞:
   * 界面把唯一动作换成「重新登录」(他没有那条路),他自家的模型清单也一起被 `withAuthExpiry` 顶掉。
   */
  it('凭据是用户自己递的(api-key)时不说「登录已失效」(#1163)', () => {
    const reading: AgentAuthStatus = { kind: 'authenticated', credentialKind: 'api-key' };
    expect(applyAuthExpiry(reading, true)).toBe(reading);
  });
});

describe('applyCredentialExpiry', () => {
  it('标着失效 ⇒ 没有可用凭据(新会话默认挪到咕咕的模型)', () => {
    expect(applyCredentialExpiry('credentialed', true)).toBe('uncredentialed');
  });

  it('没标着 ⇒ 照插件自报的那一格', () => {
    expect(applyCredentialExpiry('credentialed', false)).toBe('credentialed');
    expect(applyCredentialExpiry('unknown', false)).toBe('unknown');
  });
});
