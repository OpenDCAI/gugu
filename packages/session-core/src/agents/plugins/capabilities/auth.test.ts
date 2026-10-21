import { describe, expect, it } from 'vitest';
import { agentAuthDescriptorSchema } from './auth';

describe('agentAuthDescriptorSchema — acp-authenticate(#6335)', () => {
  it('收下协议登录方法:咕咕侧 id + 厂商自报的 methodId', () => {
    const parsed = agentAuthDescriptorSchema.parse({
      kind: 'supported',
      methods: [{ kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' }],
    });
    expect(parsed).toEqual({
      kind: 'supported',
      methods: [{ kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' }],
    });
  });

  it('methodId 必填且非空 —— 缺了就没有东西可发给 authenticate', () => {
    for (const methodId of [undefined, '']) {
      expect(
        agentAuthDescriptorSchema.safeParse({
          kind: 'supported',
          methods: [{ kind: 'acp-authenticate', id: 'google', name: 'Google', methodId }],
        }).success
      ).toBe(false);
    }
  });

  it('cli-login / api-key 形状不变', () => {
    expect(
      agentAuthDescriptorSchema.safeParse({
        kind: 'supported',
        methods: [
          { kind: 'cli-login', id: 'login', name: 'Login', args: ['login'] },
          { kind: 'api-key', id: 'key', name: 'Key', envVars: [{ name: 'K', label: 'K' }] },
        ],
      }).success
    ).toBe(true);
  });
});
