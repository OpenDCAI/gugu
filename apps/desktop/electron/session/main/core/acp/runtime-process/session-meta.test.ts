import { describe, expect, it } from 'vitest';
import {
  mergeTrustedSessionMeta,
  mergeTrustedSpawnEnv,
  stripUntrustedSessionAuthority,
  trustedPlatformInputPatch,
} from './session-meta';

describe('trustedPlatformInputPatch', () => {
  it('routes an adapter-env envelope onto capabilitySpawnEnv and nowhere else', () => {
    const patch = trustedPlatformInputPatch(
      {
        kind: 'adapter-env',
        platformAccessSessionId: 'access-env',
        spawnEnv: { KIMI_MODEL_NAME: 'gugu/glm-5.2', KIMI_MODEL_API_KEY: 't' },
        model: 'glm-5.2',
      },
      { sessionMeta: { claudeCode: {} }, spawnEnv: { KIMI_CODE_HOME: '/run/kimi' } }
    );

    expect(patch).toEqual({
      platformAccessSessionId: 'access-env',
      platformModel: 'glm-5.2',
      capabilitySpawnEnv: {
        KIMI_CODE_HOME: '/run/kimi',
        KIMI_MODEL_NAME: 'gugu/glm-5.2',
        KIMI_MODEL_API_KEY: 't',
      },
    });
    // 送错格子是静默的：sessionMeta 是 Record<string, unknown>，一份 spawn 环境放进去类型照过。
    expect(Object.keys(patch)).toEqual(['platformAccessSessionId', 'platformModel', 'capabilitySpawnEnv']);
  });

  // #6218 —— copilot 的起始推理档只有 argv 一条路,随 adapter-env 信封来,叠在能力注入那份 argv 之后。
  it('appends the adapter-env argv after the capability argv', () => {
    const patch = trustedPlatformInputPatch(
      {
        kind: 'adapter-env',
        platformAccessSessionId: 'access-args',
        spawnEnv: { COPILOT_PROVIDER_MODEL_ID: 'GLM-5.3' },
        model: 'glm-5.3',
        spawnArgs: ['--effort', 'low'],
      },
      { spawnEnv: { GUGU_HOME: '/gugu' }, spawnArgs: ['--capability-flag'] },
    );
    expect(patch.capabilitySpawnArgs).toEqual(['--capability-flag', '--effort', 'low']);
    // 信封没带 argv ⇒ 合并结果仍是能力注入那份(这一格只有合并这一个写者)。
    expect(trustedPlatformInputPatch(
      { kind: 'adapter-env', platformAccessSessionId: 'a', spawnEnv: {}, model: 'glm-5.3' },
      { spawnArgs: ['--capability-flag'] },
    ).capabilitySpawnArgs).toEqual(['--capability-flag']);
    // 两边都空 ⇒ 不产出这一格。
    expect(trustedPlatformInputPatch(
      { kind: 'adapter-env', platformAccessSessionId: 'a', spawnEnv: {}, model: 'glm-5.3' },
      {},
    )).not.toHaveProperty('capabilitySpawnArgs');
  });

  it('routes an adapter-spawn envelope onto platform, leaving the env envelope alone', () => {
    const platform = {
      model: 'gpt-5.6-sol',
      providerId: 'gugu',
      providerLabel: '咕咕',
      baseUrl: 'https://relay.test.invalid/v1',
      apiKey: 'token',
      spawnEnv: { OPENAI_API_KEY: 'token' },
    };

    expect(trustedPlatformInputPatch(
      { kind: 'adapter-spawn', platformAccessSessionId: 'access-spawn', platform },
      { spawnEnv: { CODEX_HOME: '/run/codex' } }
    )).toEqual({ platformAccessSessionId: 'access-spawn', platform, platformModel: 'gpt-5.6-sol' });
  });

  it('routes a session-meta envelope onto sessionMeta', () => {
    const patch = trustedPlatformInputPatch(
      {
        kind: 'session-meta',
        platformAccessSessionId: 'access-meta',
        sessionMeta: { claudeCode: { options: { model: 'gugu/opus' } } },
        adapterEnv: { ANTHROPIC_MODEL: 'gugu/opus' },
        model: 'opus',
      },
      { spawnEnv: { GUGU_HOME: '/gugu' } },
    );

    expect(Object.keys(patch)).toEqual([
      'platformAccessSessionId',
      'platformModel',
      'sessionMeta',
      'capabilitySpawnEnv',
    ]);
    expect(patch.platformAccessSessionId).toBe('access-meta');
    expect(patch.sessionMeta).toEqual({ claudeCode: { options: { model: 'gugu/opus' } } });
    expect(patch.capabilitySpawnEnv).toEqual({
      GUGU_HOME: '/gugu',
      ANTHROPIC_MODEL: 'gugu/opus',
    });
  });
});

describe('mergeTrustedSpawnEnv', () => {
  it('keeps the platform declaration authoritative over the capability session facilities', () => {
    expect(mergeTrustedSpawnEnv(
      { KIMI_CODE_HOME: '/run/kimi', GUGU_HOME: '/gugu', KIMI_MODEL_NAME: 'stale' },
      { KIMI_MODEL_NAME: 'gugu/glm-5.2', KIMI_MODEL_API_KEY: 'session-token' },
    )).toEqual({
      KIMI_CODE_HOME: '/run/kimi',
      GUGU_HOME: '/gugu',
      KIMI_MODEL_NAME: 'gugu/glm-5.2',
      KIMI_MODEL_API_KEY: 'session-token',
    });
  });

  it('leaves the capability side untouched when this session is not on platform quota', () => {
    const capability = { KIMI_CODE_HOME: '/run/kimi' };
    expect(mergeTrustedSpawnEnv(capability, undefined)).toBe(capability);
    expect(mergeTrustedSpawnEnv(undefined, capability)).toBe(capability);
  });

  /**
   * `capabilitySpawnEnv` 是本次会话的 spawn 补充；adapter 归属始终由 conversation key 决定，
   * 因此空 envelope 也不应被凭空制造。
   */
  it('does not invent an empty envelope when neither side has anything to say', () => {
    expect(mergeTrustedSpawnEnv(undefined, undefined)).toBeUndefined();
  });
});

describe('mergeTrustedSessionMeta', () => {
  it('appends the capability plugin beside user/platform plugins and keeps platform env authoritative', () => {
    expect(mergeTrustedSessionMeta(
      {
        claudeCode: {
          options: {
            plugins: [{ type: 'local', path: '/gugu/claude' }],
            env: { CAPABILITY_TOKEN: 'capability', SHARED: 'capability' },
            mcpServers: { gugu: { type: 'http', url: 'http://127.0.0.1/mcp' } },
          },
        },
      },
      {
        claudeCode: {
          options: {
            plugins: [{ type: 'local', path: '/user/plugin' }],
            env: { PLATFORM_TOKEN: 'platform', SHARED: 'platform' },
            model: 'glm-5.2',
          },
        },
      },
    )).toEqual({
      claudeCode: {
        options: {
          plugins: [
            { type: 'local', path: '/gugu/claude' },
            { type: 'local', path: '/user/plugin' },
          ],
          env: {
            CAPABILITY_TOKEN: 'capability',
            PLATFORM_TOKEN: 'platform',
            SHARED: 'platform',
          },
          mcpServers: { gugu: { type: 'http', url: 'http://127.0.0.1/mcp' } },
          model: 'glm-5.2',
        },
      },
    });
  });

  it('does not invent a wrapper when only one trusted source exists', () => {
    const capability = { claudeCode: { options: { plugins: [] } } };
    expect(mergeTrustedSessionMeta(capability, undefined)).toBe(capability);
    expect(mergeTrustedSessionMeta(undefined, capability)).toBe(capability);
  });
});

describe('stripUntrustedSessionAuthority', () => {
  it('removes renderer-controlled authority while preserving ordinary start input', () => {
    expect(stripUntrustedSessionAuthority({
      sessionId: 'conversation-1',
      providerId: 'claude',
      sessionMeta: { claudeCode: { options: { env: { SECRET: 'renderer' } } } },
      platform: { relayToken: 'renderer' },
      platformAccessSessionId: 'renderer-generation',
      platformModel: 'renderer-model',
      sessionPrompt: 'renderer prompt',
      mcpServers: [{ type: 'http', name: 'renderer', url: 'http://renderer.invalid' }],
      capabilitySpawnEnv: { CODEX_HOME: '/renderer-controlled' },
      runContext: { kind: 'resolved', path: '/renderer-controlled/claude' },
    })).toEqual({
      sessionId: 'conversation-1',
      providerId: 'claude',
    });
  });

  // #5869:要续哪条 provider 会话由**会话记录**说了算,渲染进程递来的那份一律不穿过。
  // 双向判据 —— 这两条只要有一条不成立,那个 bug 就会原样回来:
  //  · 渲染进程给了一个 id ⇒ 也必须被剥掉(否则"渲染端说了算"的路又通了);
  //  · 渲染进程给的是 `null`(坏掉那版里最常见的形状)⇒ 同样剥掉,**而不是留一个 null 穿过去**——
  //    留着的话宿主那侧无法区分「渲染端没给」与「渲染端给了 null」,而后者正是把历史换空的那一手。
  it('drops the renderer-supplied provider session id, whatever its value', () => {
    expect(stripUntrustedSessionAuthority({
      sessionId: 'conversation-1',
      providerSessionId: 'renderer-remembered-session',
    })).toEqual({ sessionId: 'conversation-1' });

    const strippedNull = stripUntrustedSessionAuthority({
      sessionId: 'conversation-1',
      providerSessionId: null,
    });
    expect(strippedNull).toEqual({ sessionId: 'conversation-1' });
    expect('providerSessionId' in strippedNull).toBe(false);
  });

  // 分叉从哪条会话来,只由宿主按会话记录给(host.ts 填 `forkSourceSession`,而且只在真分叉时填)。渲染进程
  // 递来的那份必须剥掉:漏剥时它就能指定任意一条会话、任意一个端点当分叉来源。改名时剥的名字没跟上,
  // 这一格就静默漏过 —— 这条钉住它。
  it('drops a renderer-supplied fork source', () => {
    const stripped = stripUntrustedSessionAuthority({
      sessionId: 'conversation-1',
      forkSourceSession: {
        id: 'someone-elses-session',
        title: 'not yours',
        providerId: 'codex',
        providerSessionEndpoint: 'http://renderer.invalid/thread',
      },
    });
    expect(stripped).toEqual({ sessionId: 'conversation-1' });
    expect('forkSourceSession' in stripped).toBe(false);
  });
});
