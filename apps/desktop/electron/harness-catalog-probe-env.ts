/**
 * 模型目录**第二遍**探测用的占位中转凭据。
 *
 * ## 为什么探针需要凭据
 *
 * 模型清单与推理档位来自同一份 `session/new` 响应(`category="model"` 与 `"thought_level"`)。
 * 没登录的用户拿不到那份响应,于是推理强度那一行**整个不画** —— owner 2026-08-26 实测:
 * 切到 Qwen 之后工具栏只剩一句「需要先登录」,模型空、档位没有。
 * 而 owner 定的线是:每家 harness 模型和推理强度都得有,**没有本身就是 bug**。
 * 何况用户此刻很可能正打算用**咕咕的**模型跑,那条路根本不需要他登录这家 harness。
 *
 * ## 为什么是占位,而不是真令牌
 *
 * ❌ **绝不能**在这里签发真令牌。`platformModelForSession` 是**按会话**绑定的:
 * 它会注册身份、排续期,而且**重签会撤销活会话手里那张票**(此后每一轮 401)。
 * 一个只读的目录探针去动那条路,等于用一次探测打死用户正在跑的会话。
 *
 * 占位够用,因为 harness 在 `session/new` 这一步只检查**凭据齐不齐**,不打模型 ——
 * qwen 自己的判据就是这个形状(`OPENAI_BASE_URL`/`_API_KEY`/`_MODEL` 三个齐了才选中 openai
 * 鉴权类型,缺一个就 `No auth type is selected` 拒绝启动)。而探针**从不发 prompt**
 * (`harness-model-catalog.ts` 抬头:「不发任何 prompt,因此不耗额度」)⇒ 这份占位永远不会被
 * 真的拿去请求。
 *
 * ⚠️ baseUrl 指向**立即拒连**的回环端口,❌ 不指向真中转:万一哪家 harness 真去打一下,
 *    我们要的是当场 ECONNREFUSED,而不是拿一个无效令牌去生产中转上刷 401。
 *
 * ⚠️ 第二遍失败是**安全**的:某家若在 `session/new` 就校验凭据有效性,它照旧回 auth-required
 *    —— 与改动前一模一样,不会更糟。调用方(probeHarnessModelCatalog)退回第一遍结论。
 *
 * ## 凭据走哪条载体,与真会话同一个分派
 *
 * 用 `platformEnvelopeKind` —— 真会话 Chat UI 注入(`sessionpage-platform-hooks.ts` 的 `acpInjector`)
 * 用的那一个 —— 决定占位凭据怎么送:
 *  · 进程配置那族(opencode / mimocode):配置文档就在物化出的环境里,与真会话的 `platformConfigured` 同路;
 *  · `adapter-env`(qwen / kimi / copilot / gemini 那族):整份进适配器进程环境;
 *  · `session-meta`(claude):settings 文档写进探针自己的临时目录(0600),路径进 `session/new` 的 `_meta`;
 *  · `adapter-spawn`(codex):一份 `AcpPlatformInjection` 交给插件的 `buildSpawn`。
 * 文档只落在调用方给的临时目录里,探完由调用方整目录删掉;❌ 碰用户自己的任何配置。
 * 送不到(没有 Chat UI 契约、契约未接通、分派不出信封)⇒ **抛**,写明是哪一家、为什么 —— ❌ 返回空了事。
 *
 * ## 它为什么住在宿主侧
 *
 * 算这份 env 要用 `engine-injection-contract` 与 `capability-bundle`,两个都在宿主 bundle。
 * 会话页那边**不许**相对路径 import 过来(esbuild 会复制一份、模块级状态分家,
 * `extension-bridge-relay` 就是这么把扩展的五个宿主动词全弄坏的),所以这里导出一个纯函数,
 * 由宿主 boot 时经 `setProbePlatformEnvResolver` 注入进去。
 */
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// 类型住在会话页那侧的消费方;type-only import 编译后擦除,不会把那边的模块打进宿主。
import type { ProbePlatformCredentials } from './session/main/core/agents/harness-model-catalog'
export type { ProbePlatformCredentials }
import { findInjectionContract } from './engine-injection-contract'
import {
  buildAcpModelCapability,
  materializeModelCapability,
  providerDeliversModelViaConfigFile,
  providerUsesSessionProcessConfig,
} from './capability-bundle'
import {
  claudeAcpPlatformSessionMeta,
  codexPlatformAuthRequest,
  codexPlatformProviderBlock,
  CODEX_PLATFORM_PROVIDER_ID,
} from '@gugu/session-plugins/agents'
import { platformEnvelopeKind } from './platform-envelope'
import { claudeAcpAdapterEnv } from './sessionpage/sessionpage-platform-hooks'
import { codexPlatformInjection } from './sessionpage/sessionpage-platform-model'

/** 立即拒连的回环地址 —— 端口 1 上不会有任何东西在听。这是中转**根**;各方言自己的形状由协议表决定。 */
export const PROBE_RELAY_ROOT = 'http://127.0.0.1:1'
/** 显式标记的假令牌:它一旦出现在任何日志里,一眼就知道不是真票。 */
export const PROBE_RELAY_TOKEN = 'gugu-catalog-probe-not-a-real-token'
/** 占位模型 id —— 探针**不读**模型清单,只读档位,所以这个 id 不会被当成读数用。 */
export const PROBE_MODEL_ID = 'gugu-catalog-probe'

function probeCredentialsFault(pluginId: string, why: string): Error {
  return new Error(`model catalog probe: ${pluginId} placeholder credentials unavailable — ${why}`)
}

/**
 * 这家在**真会话**里会拿到的那份 Chat UI 平台注入,用占位凭据重放一遍。
 * `scratchDir` 是调用方为这一趟探测建的临时目录:需要落盘的文档写在这里,调用方探完就删。
 */
export async function buildProbePlatformCredentials(
  pluginId: string,
  scratchDir: string,
): Promise<ProbePlatformCredentials> {
  const contract = findInjectionContract(pluginId, 'cui')
  if (!contract) throw probeCredentialsFault(pluginId, 'no Chat UI injection contract')
  if (!contract.wired) throw probeCredentialsFault(pluginId, `Chat UI injection (${contract.dialect}) is not wired`)
  // 同一台声明构造器(buildAcpModelCapability)—— ❌ 不在这里手拼 platformProvider:那台构造器才知道
  // 每种方言要什么形状(OpenAI 面是根 + /v1;gemini 是裸根 + 协议表原话进 platformSettingsEnv)。
  // 手拼一份等于第二台构造器,#4700 的 gemini 就是在这类「嫁接了一半」的对象上炸的。
  const capability = buildAcpModelCapability({
    dialect: contract.dialect,
    engineId: pluginId,
    model: PROBE_MODEL_ID,
    env: {},
    platformAccess: { relayUrl: PROBE_RELAY_ROOT, token: PROBE_RELAY_TOKEN, contextWindow: null },
  })
  const materialized = materializeModelCapability(capability)
  // `spawnEnv` 是 `ProcessEnv`(值可为 undefined)。undefined 的键**丢掉**而不是转成空串:
  // 空串对某些 harness 是「显式设成空」,含义与「没设」不同(claude 那条就靠空串压用户的 Key)。
  const spawnEnv = Object.fromEntries(
    Object.entries(materialized.spawnEnv ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  // 模型由这一家自己的会话包投递的那几家,真会话是在能力注入那一层解析平台额度、再让信封注入器整个跳过
  // (main.ts 的 `platformConfigured`)。探针照同一条路:
  //  · 进程配置那族(opencode / mimocode):配置文档本身就在物化出的 spawnEnv 里(`OPENCODE_CONFIG_CONTENT`);
  //  · 配置文件那族:文档由会话包物化器写,探针不物化它。方言自己有环境变量形态的(codebuddy:它那份
  //    `--settings` 文档本身就是一个 `env` 块,物化器写进文档的正是 `load()` 给的这一份)⇒ 占位凭据照这份
  //    形态进探针进程;没有的(pi 的 models.json)⇒ 抛,说清楚。
  if (providerUsesSessionProcessConfig(pluginId)) {
    if (Object.keys(spawnEnv).length === 0) {
      throw probeCredentialsFault(pluginId, 'its process-config dialect materialized no spawn environment')
    }
    return { env: spawnEnv }
  }
  if (providerDeliversModelViaConfigFile(pluginId, 'acp')) {
    if (Object.keys(spawnEnv).length === 0) {
      throw probeCredentialsFault(pluginId, 'its model is delivered by a session-bundle config file the probe does not materialize')
    }
    return { env: spawnEnv }
  }
  const settingsDocumentPath = materialized.settingsOverride ? join(scratchDir, 'probe-settings.json') : null
  const platformProvider = capability?.platformProvider ?? null
  const envelope = platformEnvelopeKind(contract, {
    spawnEnv,
    settingsDocumentPath,
    platformProvider,
    platformSettingsEnv: capability?.platformSettingsEnv ?? null,
  })

  if (envelope === 'session-meta') {
    if (!settingsDocumentPath || !materialized.settingsOverride) {
      throw probeCredentialsFault(pluginId, 'the session-meta envelope needs a settings document and none was materialized')
    }
    // 0600:文档里是(占位的)中转令牌,与真会话的会话级文件同一条纪律。
    await writeFile(settingsDocumentPath, JSON.stringify(materialized.settingsOverride), { mode: 0o600 })
    await chmod(settingsDocumentPath, 0o600)
    return {
      env: claudeAcpAdapterEnv(spawnEnv),
      sessionMeta: claudeAcpPlatformSessionMeta({ settingsDocumentPath, env: {} }),
    }
  }

  if (envelope === 'adapter-env') return { env: spawnEnv }

  if (envelope === 'adapter-spawn') {
    const provider = codexPlatformProviderBlock(capability?.platformProvider)
    const authRequest = codexPlatformAuthRequest(capability?.platformProvider)
    if (!platformProvider || !provider || !authRequest) {
      throw probeCredentialsFault(pluginId, 'could not construct the adapter-spawn platform provider')
    }
    return {
      env: {},
      platform: codexPlatformInjection({
        model: PROBE_MODEL_ID,
        providerId: CODEX_PLATFORM_PROVIDER_ID,
        providerLabel: provider.name,
        baseUrl: provider.base_url,
        apiKey: platformProvider.apiKey,
        authRequest,
        spawnEnv,
        contextWindow: null,
        reasoningEfforts: null,
        switchableModels: [],
        callableRoutes: capability?.platformCallableRoutes,
      }),
    }
  }

  throw probeCredentialsFault(pluginId, `the Chat UI injection (${contract.dialect}) does not reach the adapter`)
}
