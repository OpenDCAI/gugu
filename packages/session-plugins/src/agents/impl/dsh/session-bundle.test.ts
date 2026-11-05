import { describe, expect, it } from 'vitest';
import type {
  SessionCapabilityBundle,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { materializeDshSessionBundle } from './session-bundle';
import { platformModel } from './platform-model';

const relay = { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'tok-123', ANTHROPIC_API_KEY: '' };

function bundle(overrides: Partial<SessionCapabilityBundle> = {}): SessionCapabilityBundle {
  return {
    mcpServers: [
      { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:4100/mcp', authorizationEnv: 'GUGU_SESSION_MCP_AUTH_GUGU', alwaysLoad: true },
    ],
    env: { GUGU_HOME: '/gugu-home', GUGU_SESSION_MCP_AUTH_GUGU: 'Bearer mcp-secret' },
    model: null,
    autonomy: null,
    promptBlocks: { platform: '<gugu_platform>p</gugu_platform>' },
    ...overrides,
  } as SessionCapabilityBundle;
}

const ctx = { surface: 'acp', lifecycle: 'fresh', cwd: '/work' } as SessionMaterializationContext;
const platform = {
  dialect: 'dsh-patch-document',
  model: 'deepseek-v4.1-flash',
  platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'tok-123' },
  platformSettingsEnv: relay,
  platformModels: [
    { id: 'deepseek-v4.1-flash', displayName: 'Gugu DeepSeek V4.1 Flash', contextWindow: 1048576 },
    { id: 'deepseek-v4-pro', displayName: 'Gugu DeepSeek V4 Pro', contextWindow: null },
  ],
} as const;
const patchOf = (result: ReturnType<typeof materializeDshSessionBundle>) => {
  const at = result.argsAppend.indexOf('--patch');
  const doc = result.artifacts.find((artifact) => artifact.path === result.argsAppend[at + 1])!;
  return { doc, rows: JSON.parse(doc.content) as Array<Record<string, unknown>> };
};

describe('DeepSeek Harness 会话包', () => {
  it('每条会话都关掉会话日志、插件清单回传和反馈遥测 —— 自带 key 的会话也一样,不碰模型那两行', () => {
    const result = materializeDshSessionBundle(ctx, bundle());
    const { doc, rows } = patchOf(result);
    expect(doc.mode).toBe(0o600);
    expect(doc.path.startsWith('/gugu-home/runtime-sessions/dsh-capability-runs/')).toBe(true);
    expect(rows).toEqual([
      { id: 'session-log-deepseek', disabled: true },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
    ]);
    expect(result.env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(result.report.units.model.status).toBe('degraded');
  });

  it('平台会话:中转根(裸根,dsh 自己拼 /v1/messages)+ 可切的咕咕模型 + 令牌变量名进 patch;令牌只进进程环境', () => {
    const result = materializeDshSessionBundle(ctx, bundle({ model: platform }));
    const { doc, rows } = patchOf(result);
    expect(rows.slice(2)).toEqual([
      {
        id: 'llm-deepseek',
        config: {
          baseURL: 'https://relay.example',
          apiKeyEnv: 'GUGU_DSH_PLATFORM_KEY',
          maxTokens: 32000,
          models: [
            { id: 'deepseek-v4.1-flash', name: 'Gugu DeepSeek V4.1 Flash', contextWindow: 1048576 },
            { id: 'deepseek-v4-pro', name: 'Gugu DeepSeek V4 Pro' },
          ],
        },
      },
      { id: 'acp', config: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' } },
    ]);
    expect(doc.content).not.toContain('tok-123');
    expect(result.argsAppend.join(' ')).not.toContain('tok-123');
    expect(result.env.GUGU_DSH_PLATFORM_KEY).toBe('tok-123');
    // dsh 默认读的那个变量不发:它的凭据库先于进程环境,用户存过的 key 会顶掉平台令牌。
    expect(result.env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(result.report.units.model.status).toBe('loaded');
  });

  it('注入不成立(缺中转或令牌)就一个模型字段都不发', () => {
    const half = { ...platform, platformSettingsEnv: { ANTHROPIC_BASE_URL: 'https://relay.example' } };
    const result = materializeDshSessionBundle(ctx, bundle({ model: half }));
    expect(patchOf(result).rows.map((row) => row.id)).toEqual(['session-log-deepseek', 'plugin-package-inventory-deepseek']);
    expect(result.env).not.toHaveProperty('GUGU_DSH_PLATFORM_KEY');
  });

  it('所选模型不在这条会话的平台模型里 ⇒ 响亮拒绝', () => {
    expect(() => materializeDshSessionBundle(ctx, bundle({ model: { ...platform, model: 'glm-5.3' } })))
      .toThrow(/'glm-5.3' is not among the session's platform models/);
  });

  it('别家的方言响亮拒绝', () => {
    expect(() => materializeDshSessionBundle(ctx, bundle({ model: { dialect: 'codebuddy-settings-env', model: 'x' } })))
      .toThrow(/cannot materialize model dialect 'codebuddy-settings-env'/);
  });

  it.each([
    ['read-only', 'read-only'],
    ['edit', 'workspace-write'],
    ['full-access', 'danger-full-access'],
  ] as const)('自治级别 %s ⇒ DSH_PERMISSION_MODE=%s(建会话时定档)', (permissionMode, mode) => {
    const result = materializeDshSessionBundle(ctx, bundle({ autonomy: { mode: permissionMode === 'full-access' ? 'full-access' : 'approval-required', permissionMode } }));
    expect(result.env.DSH_PERMISSION_MODE).toBe(mode);
  });

  it('没有规划档:选了 plan 响亮拒绝,❌ 悄悄换成别的档', () => {
    expect(() => materializeDshSessionBundle(ctx, bundle({ autonomy: { mode: 'approval-required', permissionMode: 'plan' } })))
      .toThrow(/no permission mode for 'plan' or any stricter one/);
  });

  it('MCP 走 session/new.mcpServers;令牌随条目 header 走,不留在进程环境;身份自述走 session-context', () => {
    const result = materializeDshSessionBundle(ctx, bundle());
    const [gugu] = result.acp!.mcpServers as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(gugu).toMatchObject({ type: 'http', name: 'gugu' });
    expect(gugu.headers).toEqual([{ name: 'Authorization', value: 'Bearer mcp-secret' }]);
    expect(result.env).not.toHaveProperty('GUGU_SESSION_MCP_AUTH_GUGU');
    expect(result.prompt).toMatchObject({ carrier: 'session-context' });
  });

  it('declare 用协议表的裸根,❌ 用 OpenAI 面带 /v1 的 platformProvider.baseUrl', () => {
    const declared = platformModel.declare({
      explicitModel: 'deepseek-v4.1-flash',
      requestedEffort: undefined,
      envOverride: () => undefined,
      platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'tok-123' },
      platformAccess: { relayUrl: 'https://relay.example/', token: 'tok-123' },
      platformModels: undefined,
      contextWindow: undefined,
      callableRoutes: {},
      protocolEnv: (relayUrl) => ({ ANTHROPIC_BASE_URL: relayUrl, ANTHROPIC_AUTH_TOKEN: 'tok-123' }),
    });
    expect(platformModel.load(declared).spawnEnv).toEqual({
      DEEPSEEK_BASE_URL: 'https://relay.example',
      GUGU_DSH_PLATFORM_KEY: 'tok-123',
    });
  });
});
