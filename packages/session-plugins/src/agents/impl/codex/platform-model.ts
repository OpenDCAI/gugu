import {
  PLATFORM_PROVIDER_NAME,
  positiveWindow,
  trimmedValue,
  type IPlatformModelBehavior,
  type SessionModelCapability,
} from '@gugu/session-core/agents/plugins';
import { CODEX_WIRE_API, harnessPlatform } from './platform';
import { codexPlatformProviderConfigArgs } from './platform-provider-args';

/**
 * Codex addresses providers by a bare config key, so its platform provider gets an id
 * without the dash that opencode's `provider/model` syntax tolerates.
 */
export const CODEX_PLATFORM_PROVIDER_ID = 'gugu_platform';

/**
 * 「咕咕平台额度」这个 codex provider 的**声明本身**,与它被写成什么形态无关。
 *
 * codex 有两条注入面:终端会话把它渲染成 `-c model_providers.*` 的 argv,Chat UI 把它作为配置对象交给
 * 适配器。两边必须是同一个声明 —— 此前只有 argv 一种形态,于是「再加一条通道」天然意味着把这四个字段
 * 再抄一遍,而抄错一个字段的后果是会话被记成平台额度、请求却打到 api.openai.com(这正是当初两个 loader
 * 各写一份时发生过的事)。声明只留一处,形态由各自的渲染器决定。
 *
 * 令牌不在这里:`env_key` 指名的是**环境变量的名字**,值走环境。argv 在进程表里人人可读。
 */
export interface CodexPlatformProviderBlock {
  name: string;
  base_url: string;
  env_key: string;
  wire_api: typeof CODEX_WIRE_API;
}

export function codexPlatformProviderBlock(
  platformProvider: SessionModelCapability['platformProvider'],
): CodexPlatformProviderBlock | null {
  if (!platformProvider) return null;
  return {
    name: PLATFORM_PROVIDER_NAME,
    base_url: platformProvider.baseUrl,
    env_key: 'OPENAI_API_KEY',
    wire_api: CODEX_WIRE_API,
  };
}

/**
 * The `-c` overrides that put a codex process on Gugu's relay, or nothing when the session
 * is not on platform quota.
 *
 * Codex does NOT honour OPENAI_BASE_URL — verified against codex-cli 0.144.6, which ignored
 * it and went to wss://api.openai.com/v1/responses, returning 401. Redirecting it takes a
 * declared provider; without this the platform session simply cannot run. The key still
 * travels in the environment, which is what `env_key` names — never in argv, where it would
 * be readable from the process table.
 *
 * Shared on purpose: codex is reached through TWO different processes — the ACP adapter and
 * the session page's app-server — and each has its own loader. When only one of them knew about
 * this block, session-page sessions were booked as platform quota while the app-server talked to
 * api.openai.com with whatever key was in the environment. One definition is what stops that
 * from silently coming back.
 */
export function codexPlatformProviderArgs(
  platformProvider: SessionModelCapability['platformProvider'],
  /** #6921 同一份声明的出图开关;与 app-server / ACP 那两份逐字相同,❌ 让可见客户端说另一种话。 */
  callableRoutes: SessionModelCapability['platformCallableRoutes'],
): string[] {
  const block = codexPlatformProviderBlock(platformProvider);
  if (!block) return [];
  return codexPlatformProviderConfigArgs({
    providerId: CODEX_PLATFORM_PROVIDER_ID,
    providerName: block.name,
    baseUrl: block.base_url,
    ...(callableRoutes ? { callableRoutes } : {}),
  });
}

/**
 * codex 的「网关」登录方式:一个**只活在内存里**的 auth request,用来过掉 `session/new` 之前那道闸。
 *
 * 为什么需要它:一个没有 codex 账号的用户(平台额度用户正是这一类)在 ACP 上会先撞 `authRequired`,
 * 而 codex 只认三种登录方式。api-key 那条路会调 `accountLogin({type:'apiKey'})`,把这次会话的中转令牌
 * **明文写进用户自己的 `auth.json`** —— 一个会话级、随时会被撤销的令牌落进用户的长期凭据文件,既污染
 * 他自己的 codex 登录态,又把令牌留在了磁盘上。实证之后否决。gateway 这条路则只在适配器进程内存里
 * 攒出一份 `gatewayConfig`(name/base_url/http_headers/wire_api),零落盘。
 *
 * 它和 `codexPlatformProviderArgs` 指向的是**同一个** relay、同一个令牌、同一个模型,只是一个走登录闸、
 * 一个走 provider 声明 —— 两条通道并发射,缺哪一条会话都起不来。
 *
 * 令牌走 `headers.Authorization`,而不是命令行:适配器把这份文档当值收下(codex-acp 从
 * `DEFAULT_AUTH_REQUEST` 环境变量读它),与本仓「凭据只走环境、绝不进 argv」的规矩一致。
 */
export interface CodexPlatformAuthRequest {
  methodId: 'gateway';
  _meta: {
    gateway: {
      baseUrl: string;
      providerName: string;
      headers: Record<string, string>;
    };
  };
}

export function codexPlatformAuthRequest(
  platformProvider: SessionModelCapability['platformProvider'],
): CodexPlatformAuthRequest | null {
  // 非平台会话不该被塞进任何登录方式 —— 那是替用户改他自己的 codex 登录态。
  if (!platformProvider) return null;
  return {
    methodId: 'gateway',
    _meta: {
      gateway: {
        // 与 provider 声明同一个地址:两边都要带 /v1(codex 打的是 OpenAI 那一面的 root)。
        baseUrl: platformProvider.baseUrl,
        providerName: PLATFORM_PROVIDER_NAME,
        headers: { Authorization: `Bearer ${platformProvider.apiKey}` },
      },
    },
  };
}

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_CODEX_MODEL'),
    reasoningEffort: input.envOverride('GUGU_ACP_CODEX_REASONING_EFFORT'),
    serviceTier: input.envOverride('GUGU_ACP_CODEX_SERVICE_TIER'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    // codex 的 model catalog 按模型声明推理档(#6447)—— 与窗口同一份声明,同一处嫁接。
    ...(input.platformProvider && input.platformAccess?.reasoningEfforts
      ? { reasoningEfforts: input.platformAccess.reasoningEfforts }
      : {}),
    // 令牌在哪些路由上能调哪些模型(#6921):codex 据此决定开不开它自己的出图工具。
    ...(input.platformProvider && Object.keys(input.callableRoutes).length > 0
      ? { platformCallableRoutes: input.callableRoutes }
      : {}),
  }),
  load: (model) => {
    const extraArgs: string[] = [];
    const selectedModel = trimmedValue(model.model);
    const reasoningEffort = trimmedValue(model.reasoningEffort);
    const serviceTier = trimmedValue(model.serviceTier);
    if (selectedModel) extraArgs.push('-c', `model=${selectedModel}`);
    if (reasoningEffort) extraArgs.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    if (serviceTier) extraArgs.push('-c', `service_tier=${serviceTier}`);
    // Codex derives its own context ceiling from the model slug against a built-in table; a
    // gateway alias is not in it, so the window has to be stated the same way the model is.
    // Same value, same source as the other two dialects — only the syntax differs.
    if (positiveWindow(model.contextWindow)) {
      extraArgs.push('-c', `model_context_window=${model.contextWindow}`);
    }
    extraArgs.push(...codexPlatformProviderArgs(model.platformProvider, model.platformCallableRoutes));
    return extraArgs.length > 0 ? { extraArgs } : {};
  },
};
