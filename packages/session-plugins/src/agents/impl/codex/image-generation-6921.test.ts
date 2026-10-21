import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { acpPlatformInjectionSchema } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { provider } from './index';
import {
  codexPlatformProviderConfigArgs,
  CODEX_ACTOR_AUTHORIZATION_HEADER,
  CODEX_ACTOR_AUTHORIZATION_SWITCH,
} from './platform-provider-args';
import { CODEX_GUGU_CAPABILITY_PACKAGE, materializeCodexSessionBundle } from './session-bundle';

/**
 * #6921 codex 0.160 只在 provider 的 `http_headers` 里有非空 `x-openai-actor-authorization` 时才挂出图工具。
 * 开不开只看签发响应的 `callable_routes` 里,codex 自己打的那条路由上有没有它写死的那个模型。
 */
const HEADER_ARG = `model_providers.gugu_platform.http_headers={ "${CODEX_ACTOR_AUTHORIZATION_HEADER}" = "${CODEX_ACTOR_AUTHORIZATION_SWITCH}" }`;
const SEARCH_OFF_ARG = 'web_search="disabled"';

const GRANTED = {
  '/v1/responses': ['gpt-6-astra', 'glm-5.3'],
  '/v1/images/generations': ['gpt-image-2'],
  '/v1/images/edits': ['gpt-image-2'],
};

/** 每一种「不该开」的形状:老服务端没给、给了空表、出图路由上没有 codex 的模型、只有对话路由。 */
const NOT_GRANTED: Array<[string, Record<string, string[]> | undefined]> = [
  ['字段缺失(老服务端)', undefined],
  ['空表', {}],
  ['出图路由上没有 gpt-image-2', { '/v1/images/generations': ['dall-e-3'] }],
  ['gpt-image-2 只在别的路由上', { '/v1/responses': ['gpt-image-2'] }],
  ['只有对话路由', { '/v1/responses': ['gpt-6-astra'] }],
];

/** argv 里 `-c <value>` 这一对是否在。只看值会把同名的别处(比如 cwd 信任)误判成有。 */
function hasConfig(args: readonly string[], value: string): boolean {
  return args.some((arg, index) => arg === value && args[index - 1] === '-c');
}

function providerArgs(callableRoutes?: Record<string, string[]>) {
  return codexPlatformProviderConfigArgs({
    providerId: 'gugu_platform',
    providerName: 'Gugu 平台额度',
    baseUrl: 'http://127.0.0.1:1/relay/v1',
    ...(callableRoutes ? { callableRoutes } : {}),
  });
}

// ACP 腿:宿主把 AcpPlatformInjection 交给 buildSpawn,它的 argv 经咕咕的桥原样转给 `codex app-server`。
function acpArgs(callableRoutes?: Record<string, string[]>): string[] {
  // 先过一遍真 schema:zod 会静默丢掉没声明的键,漏声明时开关在这一跳就没了。
  const platform = acpPlatformInjectionSchema.parse({
    providerId: 'gugu_platform',
    providerLabel: 'Gugu 平台额度',
    baseUrl: 'http://127.0.0.1:1/relay/v1',
    model: 'gpt-6-astra',
    apiKey: 'k',
    spawnEnv: {},
    ...(callableRoutes ? { callableRoutes } : {}),
  });
  return provider.behavior.acp!.buildSpawn({
    cwd: '/work',
    env: { GUGU_CODEX_BIN: '/x/codex' },
    cli: 'codex',
    adapterEntry: '/x/gugu-codex-app-server-acp.mjs',
    platform,
  }).args;
}

// app-server 腿(会话页终端):物化器的 argsAppend 进 `codex app-server` 自己的 argv。
function appServerArgs(callableRoutes?: Record<string, string[]>): readonly string[] {
  const bundle: SessionCapabilityBundle = {
    mcpServers: [],
    env: { GUGU_HOME: '/gugu' },
    model: {
      dialect: 'codex-config-flags',
      model: 'gpt-6-astra',
      platformProvider: { baseUrl: 'http://127.0.0.1:1/relay/v1', apiKey: 'k' },
      ...(callableRoutes ? { platformCallableRoutes: callableRoutes } : {}),
    },
    autonomy: null,
    promptBlocks: {},
    packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
  };
  return materializeCodexSessionBundle({ surface: 'app-server', lifecycle: 'fresh', cwd: '/work' }, bundle).argsAppend;
}

describe('#6921 令牌能调 codex 的出图模型 ⇒ 给 gugu_platform 加开关头', () => {
  it('provider 声明带上 http_headers 里的开关头,值非空', () => {
    const args = providerArgs(GRANTED);
    expect(hasConfig(args, HEADER_ARG)).toBe(true);
    expect(CODEX_ACTOR_AUTHORIZATION_SWITCH.trim()).not.toBe('');
  });

  it.each([
    ['app-server argv', appServerArgs],
    ['ACP 腿 argv', acpArgs],
  ])('%s:条件满足时带头,不带 callable_routes 时不带', (_surface, argsFor) => {
    expect(hasConfig(argsFor(GRANTED), HEADER_ARG)).toBe(true);
    expect(argsFor().join('\n')).not.toContain(CODEX_ACTOR_AUTHORIZATION_HEADER);
  });

  it.each(NOT_GRANTED)('%s ⇒ 两个面都一个字不加', (_case, routes) => {
    for (const args of [providerArgs(routes), appServerArgs(routes), acpArgs(routes)]) {
      expect(args.join('\n')).not.toContain(CODEX_ACTOR_AUTHORIZATION_HEADER);
      expect(hasConfig(args, SEARCH_OFF_ARG)).toBe(false);
    }
  });

  it('不带 callable_routes 时 provider 声明与改动前逐字一致', () => {
    expect(providerArgs()).toEqual([
      '-c', 'model_provider=gugu_platform',
      '-c', 'model_providers.gugu_platform.name="Gugu 平台额度"',
      '-c', 'model_providers.gugu_platform.base_url="http://127.0.0.1:1/relay/v1"',
      '-c', 'model_providers.gugu_platform.env_key=OPENAI_API_KEY',
      '-c', 'model_providers.gugu_platform.wire_api=responses',
      '-c', 'features.apps=false',
    ]);
  });
});

describe('#6921 同一个头会给 lite 模型挂上打 /v1/alpha/search 的 web.run', () => {
  it('网关没有搜索路由 ⇒ 开出图的同时关掉联网搜索', () => {
    for (const args of [providerArgs(GRANTED), appServerArgs(GRANTED), acpArgs(GRANTED)]) {
      expect(hasConfig(args, SEARCH_OFF_ARG)).toBe(true);
    }
  });

  it('网关声明了 /v1/alpha/search ⇒ 搜索不动', () => {
    const routes = { ...GRANTED, '/v1/alpha/search': ['gpt-6-astra'] };
    const args = providerArgs(routes);
    expect(hasConfig(args, HEADER_ARG)).toBe(true);
    expect(hasConfig(args, SEARCH_OFF_ARG)).toBe(false);
  });
});
