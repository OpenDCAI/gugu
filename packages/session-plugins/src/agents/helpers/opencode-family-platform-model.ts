import {
  PLATFORM_PROVIDER_NAME,
  positiveWindow,
  trimmedValue,
  type PlatformModelLoad,
  type SessionModelCapability,
} from '@gugu/session-core/agents/plugins';
import { openCodeFamilyReasoningEntry } from './opencode-family-model-config';

/** The id Gugu gives the provider block it injects into an opencode session. */
export const OPENCODE_PLATFORM_PROVIDER_ID = 'gugu-platform'

// OpenCode validates custom model entries against its current models.dev shape. The
// served GLM-5.2 catalog entry is context=1,000,000 and output=131,072; keep the
// output limit in the provider block instead of letting session/new reject the config.
const OPENCODE_PLATFORM_OUTPUT_LIMIT = 131_072

/**
 * opencode 系(opencode 本体 + 它的 fork MiMo-Code)的整份配置文档注入。
 *
 * 文档经**一个环境变量**整体送进去,不落盘:它是 merge 到用户自己的配置之上而不是替换
 * (opencode 1.18.25 实测:用户 opencode.json 里声明的 provider 与注入的那个同时解析得到),
 * 所以能只为这一个进程钉住模型,而不动用户的 provider / agent / MCP。
 *
 * ⚠️ **两家必须共用这一份**。它们是同一份上游代码,配置形状逐字相同;各写一份的话,
 *    改了一边忘了另一边 = 那家收到一份它读不懂的文档,而 opencode 系对读不懂的配置是
 *    **静默走默认**,不是报错 —— 症状会表现成「界面选了咕咕的模型、请求却带着别的模型名」,
 *    然后被网关按白名单拒掉,离病根隔着两层。
 *
 * ❌ 非平台会话只钉模型、不写 provider:写了就会把用户自己配的端点顶掉。
 */
/**
 * opencode 系的协议旋钮是平台 provider 的 `npm` 包(它自己文档的原话:「`@ai-sdk/openai-compatible`(用于 `/v1/chat/completions`);
 * 如果模型走 `/v1/responses`,用 `@ai-sdk/openai`」),由调用方那一家声明的 `wireProtocol` 查出:表里没有那一档就编译不过。
 */
const OPENCODE_FAMILY_SDK_PACKAGE = {
  'openai-responses': '@ai-sdk/openai',
  'openai-chat-completions': '@ai-sdk/openai-compatible',
} as const

export function openCodeFamilyConfigContent(
  envKey: 'OPENCODE_CONFIG_CONTENT' | 'MIMOCODE_CONFIG_CONTENT',
  protocol: keyof typeof OPENCODE_FAMILY_SDK_PACKAGE,
  model: SessionModelCapability,
  reasoning: Parameters<typeof openCodeFamilyReasoningEntry>[0],
): PlatformModelLoad {
  const selectedModel = trimmedValue(model.model)
  if (!selectedModel) return {}
  const platform = model.platformProvider
  if (!platform) {
    return { spawnEnv: { [envKey]: JSON.stringify({ model: selectedModel }) } }
  }
  const contextWindow = model.contextWindow
  // 自定义 provider 下的模型在 catalog 里没有条目,不声明窗口它就没有窗口。
  // `limit.context` 就是那个字段,和模型 id 写在同一条上。
  const modelEntry = (window: number | null | undefined) => ({
    limit: {
      output: OPENCODE_PLATFORM_OUTPUT_LIMIT,
      ...(positiveWindow(window) ? { context: window } : {}),
    },
    // 推理档 —— `variants`(整张表)+ `options`(这次会话选中的那一档)。与插件物化那条路
    // **共用同一个函数**,理由同 `npm` / `limit`:两边漂移时,漂了的那家会静默走它自己的默认。
    ...openCodeFamilyReasoningEntry(reasoning, model.reasoningEffort),
  })
  /**
   * 这个 provider 下声明**整组**可切模型,而不只是选中的那一个。
   *
   * opencode 的模型 id 是 `provider/model`,而它的清单是 spawn 时那份配置文档决定的 ——
   * 没写进来的模型在会话里根本选不中(实测:只声明一个 ⇒ 417 条清单里咕咕只有 1 条)。
   * 令牌那一侧的白名单是同一组(服务端 `switchableModelSet` = 这条协议下上架的全部平台模型),
   * 所以这里声明的每一条,网关都认。
   *
   * 每条用**它自己的**窗口:拿选中模型的窗口套给全组会让换过去之后的压缩点整段错位。
   * 服务端没报窗口的省略 `limit.context`,让 opencode 用它自己的默认 —— ❌ 不猜一个数。
   */
  const platformModels = model.platformModels?.length
    ? model.platformModels
    : [{ id: selectedModel, displayName: selectedModel, contextWindow }]
  const models: Record<string, unknown> = {}
  for (const entry of platformModels) {
    const id = entry.id.trim()
    if (!id) continue
    models[id] = modelEntry(entry.contextWindow ?? (id === selectedModel ? contextWindow : null))
  }
  // 选中的那个必须在表里 —— 目录与令牌之间有任何时序差时,至少这一轮跑得动。
  if (!models[selectedModel]) models[selectedModel] = modelEntry(contextWindow)
  // 模型的寻址方式是 `provider/model`,所以平台模型只有在同一份文档里连 provider 一起声明
  // 之后才选得中。两半都是会话级的,随进程消亡。
  return {
    spawnEnv: {
      [envKey]: JSON.stringify({
        provider: {
          [OPENCODE_PLATFORM_PROVIDER_ID]: {
            // ⚠️ 这一个字段就是 opencode 系的**协议旋钮**。它自己的文档原话:
            //   「对其它 OpenAI 兼容供货商用 `@ai-sdk/openai-compatible`(用于 `/v1/chat/completions`);
            //     如果模型走 `/v1/responses`,用 `@ai-sdk/openai`」。
            // 从前这里是 `@ai-sdk/openai-compatible` ⇒ 打 `/v1/chat/completions`,而 2026-09-17
            // 之后网关按路径选渠道、没有那条路由 ⇒ opencode 对每一个自营模型都 503(#5824,
            // owner 在 1.18.28 上撞到的就是这一格)。
            // 实测同一份配置只换这一个字段:compatible → chat/completions;openai → responses。
            // ⇒ 值由那一家 platform.ts 的 wireProtocol 查出(`OPENCODE_FAMILY_SDK_PACKAGE`),只有一处可改。
            npm: OPENCODE_FAMILY_SDK_PACKAGE[protocol],
            name: PLATFORM_PROVIDER_NAME,
            options: { baseURL: platform.baseUrl, apiKey: platform.apiKey },
            models,
          },
        },
        model: `${OPENCODE_PLATFORM_PROVIDER_ID}/${selectedModel}`,
      }),
    },
  }
}
