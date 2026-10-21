import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { agentSteersActiveAcpTurn } from '@shared/core/agents/agent-payload';
import { buildAgentMetadataList } from './agent-payload-builder';

/**
 * 直通判据(spec: harness-auth-surface):payload 的 auth 就是插件声明的那一份。
 * 从前 `buildAuthDescriptor` 会把没声明 auth 的家兜成 supported + `args: []` 的通用
 * cli-login,渲染层「Sign in to use {name} models」那条解锁组就是这么凭空长出来的
 * (owner 2026-09-19 令删:pi 的登录是用户自己终端里的事)。
 * ⚠️ renderer 侧的阴性对照(initial-session-section.test.ts 的 nologin fixture)
 *    喂的是 mock payload,拦不住主进程这一层的伪造 —— 这条判据只在这里能红。
 */
describe('agent payload auth surface', () => {
  it('passes the declared auth descriptor through instead of fabricating a generic cli-login', () => {
    const list = buildAgentMetadataList();
    expect(list.length).toBeGreaterThan(0);

    // 阳性对照(声明侧):claude 声明了 supported,payload 里那条方法带真 argv。
    const claude = list.find((entry) => entry.id === 'claude');
    expect(claude, 'claude 不在列表里 —— 上架闸变了,这条判据要跟着改').toBeDefined();
    expect(claude!.capabilities.auth.kind).toBe('supported');

    // 直通性质:每一家 payload 的 auth 都等于它自己的声明 —— 没声明的家保持 {kind:'none'},
    // 不再被兜成通用 cli-login。pi 在 dev 上还没上架(它的产品面读数由 mac1 实测钉),
    // 这里钉的是「在列的每一家」,包括 dev 上在列的未声明家(grok / droid / cursor / copilot…)。
    const undeclared: string[] = [];
    for (const entry of list) {
      const provider = pluginRegistry.get(entry.id);
      expect(provider, `registry 里找不到 ${entry.id}`).toBeDefined();
      expect(entry.capabilities.auth).toEqual(provider!.capabilities.auth);
      if (provider!.capabilities.auth.kind === 'none') undeclared.push(entry.id);
    }
    // 在列清单里一个未声明的家都没有 ⇒ 直通判据对「伪造」不设防 —— 红出来提醒换对照。
    expect(undeclared.length, '在列清单全是 auth 声明家 —— 未声明侧没有对照了').toBeGreaterThan(0);
  });
});

/**
 * #6574 排队提示的「立即发送」按这家声明的注入档位分两种。渲染层读的是 payload 里那一格 —— 声明若没跟着
 * 到这里(schema 少一支会被 zod 静默 strip),每一家都会被读成「插不了」,一条判据都不会红。
 */
describe('the declared acp injection timing reaches the renderer payload', () => {
  it('claude / codex steer the running turn; a family without a declaration does not', () => {
    const list = buildAgentMetadataList();
    const steers = (id: string) => {
      const entry = list.find((candidate) => candidate.id === id);
      expect(entry, `${id} 不在上架清单里 —— 换一家同类的当对照`).toBeDefined();
      return agentSteersActiveAcpTurn(entry!.capabilities);
    };
    expect(steers('claude')).toBe(true);
    expect(steers('codex')).toBe(true);
    // acp 没声明注入档位 ⇒ 插不了(阴控:判据不是恒真)。
    expect(steers('mimocode')).toBe(false);
  });
});
