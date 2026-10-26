import type { PlatformCallableRoutes } from '@gugu/session-core/agents/plugins';
import { PLATFORM_STANDALONE_SEARCH_ROUTE, platformStandaloneSearchGranted } from '@gugu/session-core/agents/plugins';
import { CODEX_WIRE_API } from './platform';

/**
 * 「这条 codex 会话花的是咕咕额度」这件事在 argv 上的**唯一**写法。
 *
 * 此前同一串 `-c model_providers.*` 抄了三份(插件的 ACP 起法、会话包物化器、宿主给可见 TUI 的那份),
 * 加一格就得改三处、漏一处就是两个进程说两种话。现在三处都调这里。
 *
 * 除 provider 声明外还有一格 `features.apps=false`(#6264):codex 的 ChatGPT Apps 连接器
 * (`codex_apps` MCP)只认用户**自己的 ChatGPT 登录**(codex-rs `host_owned_codex_apps_enabled`:
 * `apps_enabled && auth.uses_codex_backend()`)。咕咕额度的会话从不用那份登录 —— 它过期时,每条会话
 * 开头都会在终端里甩一整段 `MCP client for codex_apps failed to start … 401 token_expired`,
 * 而它本就不该起。官方开关是 `features.apps`(learn.chatgpt.com/docs/config-file/config-reference,
 * 「Enable app (connector) integrations (stable; on by default)」),按次用 `-c` 关,❌ 不动用户的配置文件。
 * 自家账号的会话不经过这里,codex 自己的行为原样保留。
 *
 * 令牌不在这里:`env_key` 指名的是环境变量的**名字**,值走环境 —— argv 在进程表里人人可读。
 * 引号规则按值的性质分:显示名和 URL 是 TOML 字符串;env_key / wire_api 是裸标识符,不加引号
 * (与线上跑通验证过的那一串逐字节相同)。
 */
export const CODEX_PLATFORM_DISABLE_APPS_ARGS: readonly string[] = ['-c', 'features.apps=false'];

/**
 * #6921 codex 内置出图工具(`image_gen.imagegen`)的开关 —— 只写 codex **自己的**事实,❌ 不写网关在卖什么。
 *
 * codex 0.160 给自定义 provider 挂这个工具,要 provider 能「代表 OpenAI 身份」:
 * `requires_openai_auth=false` 且 `http_headers`(❌ `env_http_headers` 不算)里有非空的
 * `x-openai-actor-authorization`(codex-rs `model-provider-info/src/lib.rs:621` `uses_openai_actor_authorization`;
 * 闸在 `core/src/tools/spec_plan.rs:727` `image_generation_available`,扩展侧 `ext/image-generation/src/extension.rs:43`)。
 * codex 只看这个头**在不在**,不看值 —— 所以值是一个固定串,它只是开关,不是凭据。
 *
 * 出图请求打 `<base_url>/images/generations`(`codex-api/src/endpoint/images.rs:68`),模型名写死
 * `gpt-image-2`(`ext/image-generation/src/tool.rs:58`);咕咕给 codex 的 base_url 是网关的 `/v1` 根,
 * ⇒ 网关看到的路由就是下面这一条。服务端没给 `callable_routes`(老版 edge function)= 没有出图能力。
 */
export const CODEX_IMAGE_GENERATION_ROUTE = '/v1/images/generations';
export const CODEX_IMAGE_GENERATION_MODEL = 'gpt-image-2';
export const CODEX_ACTOR_AUTHORIZATION_HEADER = 'x-openai-actor-authorization';
export const CODEX_ACTOR_AUTHORIZATION_SWITCH = 'gugu-image-generation-switch';
/**
 * 同一个头也能打开 codex 的独立联网搜索工具 `web.run`(`ext/web-search/src/extension.rs:47`),它打
 * `<base_url>/alpha/search`(`codex-api/src/endpoint/search.rs:15`)。
 */
export const CODEX_STANDALONE_SEARCH_ROUTE = PLATFORM_STANDALONE_SEARCH_ROUTE;

export function codexImageGenerationGranted(routes: PlatformCallableRoutes | undefined): boolean {
  return routes?.[CODEX_IMAGE_GENERATION_ROUTE]?.includes(CODEX_IMAGE_GENERATION_MODEL) ?? false;
}

/**
 * 出图开关的 argv。条件不满足 ⇒ 一个字都不加,codex 的行为与改动前逐字一致。
 *
 * ⚠️ 打开它的同时要关掉联网搜索,除非这个会话起步的模型在网关的搜索路由上:codex 对 `use_responses_lite` 的模型
 * (它自带目录里的 gpt-6-* / gpt-5.6-*,咕咕的模型目录原样沿用)一见到这个头就挂上 `web.run`
 * (`spec_plan.rs:1038` `standalone_web_search_enabled`),而网关上没有 `/v1/alpha/search` ——
 * 模型一调用,`FunctionCallError::Fatal`(`ext/web-search/src/tool.rs:151`)整轮报错。
 * 这类模型改动前本来就没有联网搜索(lite 不发托管搜索,`spec_plan.rs:628`),关掉它们保持原样。
 * 搜索开关是会话级的、不分模型(`config.web_search_mode`),所以同一会话里的非 lite 模型会一并
 * 失去托管搜索 —— 这是 codex 0.160 下两条要求不能同时成立的那一处,见 #6921 的 PR 说明。
 * 只关独立搜索的开关不存在:`features.standalone_web_search=false` 对 lite 模型无效(同一行里
 * `use_responses_lite ||` 先短路);provider 的 `supports_standalone_web_search` 是「或」进去的打开项。
 * 判据看**起步模型**,❌ 看「搜索路由上有没有任何一个模型」:后者让 luna 这类没有搜索渠道的会话也挂上 `web.run`,
 * 模型一搜就整轮报错(生产 10-21)。会话中途换到不能搜的模型,缺口还在:`web.run` 的请求失败一律是
 * `FunctionCallError::Fatal`(codex rust-v0.160.0 `ext/web-search/src/tool.rs:151`),咕咕这边没有开关把它降成工具失败。
 * ⚠️ 可见的 `--remote` TUI 建 thread / resume 时会把它**自己**的 `web_search` 当线程配置送给 app-server
 * (codex-rs `tui/src/app_server_session.rs:1856`),盖过 app-server 进程级的 `-c` ⇒ 可见客户端必须拿
 * 同一份 argv(`codexPlatformProviderArgs`):无授权时保持 disabled,有授权时显式 live,两条腿不能互相覆盖。
 */
function codexImageGenerationArgs(providerId: string, routes: PlatformCallableRoutes | undefined, model: string | undefined): string[] {
  if (!codexImageGenerationGranted(routes)) return [];
  const header = `${JSON.stringify(CODEX_ACTOR_AUTHORIZATION_HEADER)} = ${JSON.stringify(CODEX_ACTOR_AUTHORIZATION_SWITCH)}`;
  return [
    // 内联表写法:codex 把 `-c` 的键按 `.` 裸切(`config/src/overrides.rs`),整张表一次给。
    '-c', `model_providers.${providerId}.http_headers={ ${header} }`,
    ...(platformStandaloneSearchGranted(routes, model) ? [] : ['-c', 'web_search="disabled"']),
  ];
}

export function codexPlatformProviderConfigArgs(input: {
  providerId: string;
  providerName: string;
  baseUrl: string;
  /** 签发响应的 `callable_routes`;缺席 = 老服务端 = 不开出图。 */
  callableRoutes?: PlatformCallableRoutes;
  /** 会话起步的模型(网关别名):它在搜索路由上,才留着联网搜索。 */
  model?: string;
}): string[] {
  const id = input.providerId;
  return [
    '-c', `model_provider=${id}`,
    '-c', `model_providers.${id}.name=${JSON.stringify(input.providerName)}`,
    '-c', `model_providers.${id}.base_url=${JSON.stringify(input.baseUrl)}`,
    '-c', `model_providers.${id}.env_key=OPENAI_API_KEY`,
    '-c', `model_providers.${id}.wire_api=${CODEX_WIRE_API}`,
    ...codexImageGenerationArgs(id, input.callableRoutes, input.model?.trim()),
    // Explicitly select standalone search even without the image-generation actor header.
    // The remote TUI must receive this same block: its thread configuration overrides the server's.
    ...(platformStandaloneSearchGranted(input.callableRoutes, input.model) ? [
      '-c', `model_providers.${id}.supports_standalone_web_search=true`,
      '-c', 'features.standalone_web_search=true',
      '-c', 'web_search="live"',
    ] : []),
    ...CODEX_PLATFORM_DISABLE_APPS_ARGS,
  ];
}
