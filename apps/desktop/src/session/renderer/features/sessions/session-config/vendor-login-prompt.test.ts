import { describe, expect, it } from 'vitest';
import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import { resolveLegLoginGate } from './vendor-login-prompt';

const REQUIRED = { vendorAccount: { kind: 'required' } } as unknown as AgentCapabilities;
const OPTIONAL = {} as AgentCapabilities;
const AUTH_REQUIRED = {
  kind: 'auth-required',
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
} as never;
const READY = { kind: 'ready' } as never;
const agyTarget = { program: 'antigravity-cli', method: { name: 'Google 账号' } };
const mainTarget = { program: undefined, method: { name: 'Google 账号' } };

describe('resolveLegLoginGate(#6335:按这条腿跑的那个程序问)', () => {
  it('伴随程序那条腿:只看它自己的读数 —— 明确没登才拦,主程序目录的 auth-required 不作数', () => {
    expect(
      resolveLegLoginGate({ capabilities: OPTIONAL, catalogState: READY, target: agyTarget, programStatus: { kind: 'unauthenticated' } })
    ).toEqual({ prompt: true, signIn: true, methodNames: ['Google 账号'] });
    // 主程序没登(目录 auth-required)、agy 已登 ⇒ 编程模式不拦
    expect(
      resolveLegLoginGate({ capabilities: REQUIRED, catalogState: AUTH_REQUIRED, target: agyTarget, programStatus: { kind: 'authenticated' } })
    ).toEqual({ prompt: false, signIn: false, methodNames: [] });
    // 判不出 / 在途 ⇒ 不拦(判不出不是没登录)
    for (const programStatus of [{ kind: 'unknown' as const }, null, undefined]) {
      expect(
        resolveLegLoginGate({ capabilities: OPTIONAL, catalogState: READY, target: agyTarget, programStatus }).prompt
      ).toBe(false);
    }
  });

  it('主程序那条腿:逐字节照旧 —— 目录 auth-required + vendorAccount 才弹,入口只要 auth-required 且声明了登录', () => {
    expect(
      resolveLegLoginGate({ capabilities: REQUIRED, catalogState: AUTH_REQUIRED, target: mainTarget, programStatus: null })
    ).toEqual({ prompt: true, signIn: true, methodNames: ['Log in with Google'] });
    // agy 的读数对通用模式不作数
    expect(
      resolveLegLoginGate({ capabilities: OPTIONAL, catalogState: AUTH_REQUIRED, target: mainTarget, programStatus: { kind: 'unauthenticated' } })
    ).toEqual({ prompt: false, signIn: true, methodNames: ['Log in with Google'] });
    expect(
      resolveLegLoginGate({ capabilities: REQUIRED, catalogState: READY, target: mainTarget, programStatus: null })
    ).toEqual({ prompt: false, signIn: false, methodNames: [] });
    // 这条腿在咕咕里没有登录动作 ⇒ 不给入口
    expect(
      resolveLegLoginGate({ capabilities: OPTIONAL, catalogState: AUTH_REQUIRED, target: null, programStatus: null }).signIn
    ).toBe(false);
  });
});
